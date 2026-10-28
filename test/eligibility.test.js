'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fromWebhook, fromGraphQL, maskEmail } = require('../src/normalize');
const { prefilter, freshCheck } = require('../src/eligibility');
const { DEFAULTS } = require('../src/settings');
const { RULES } = require('../src/rules');

// The engine hands these functions the dashboard settings plus the fixed rules.
const settings = { ...DEFAULTS, ...RULES, mode: 'live', traySku: 'GT-TRAY', trayVariantId: '1' };

function webhook(overrides = {}) {
  return {
    id: 13527749558651,
    admin_graphql_api_id: 'gid://shopify/Order/13527749558651',
    name: '#38014',
    order_number: 38014,
    created_at: '2026-11-06T09:00:00+00:00',
    cancelled_at: null,
    test: false,
    email: 'jane.doe@example.com',
    tags: 'Linc Queue, VIP',
    financial_status: 'paid',
    fulfillment_status: null,
    subtotal_price: '54.00',
    current_subtotal_price: '54.00',
    currency: 'GBP',
    customer: { id: 777, admin_graphql_api_id: 'gid://shopify/Customer/777', email: 'jane.doe@example.com' },
    shipping_address: { country_code: 'GB' },
    line_items: [{ sku: 'fg1527D_v1', quantity: 2, current_quantity: 2 }],
    ...overrides,
  };
}

function gqlNode(overrides = {}) {
  return {
    id: 'gid://shopify/Order/13527749558651',
    legacyResourceId: '13527749558651',
    name: '#38014',
    createdAt: '2026-11-06T09:00:00Z',
    cancelledAt: null,
    test: false,
    email: 'jane.doe@example.com',
    tags: ['Linc Auto', 'Linc Queue'],
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    subtotalPriceSet: { shopMoney: { amount: '54.0', currencyCode: 'GBP' } },
    currentSubtotalPriceSet: { shopMoney: { amount: '54.0', currencyCode: 'GBP' } },
    customer: { id: 'gid://shopify/Customer/777', legacyResourceId: '777' },
    shippingAddress: { countryCodeV2: 'GB' },
    lineItems: { nodes: [{ sku: 'FG1527d_V1', quantity: 2, currentQuantity: 2 }] },
    ...overrides,
  };
}

test('webhook and GraphQL orders normalise to the same shape', () => {
  const a = fromWebhook(webhook());
  const b = fromGraphQL(gqlNode());
  for (const key of ['id', 'gid', 'name', 'number', 'createdAt', 'cancelled', 'test', 'financialStatus', 'fulfillmentStatus', 'subtotal', 'currentSubtotal', 'currency', 'customerId', 'customerGid', 'country']) {
    assert.deepEqual(a[key], b[key], key);
  }
  assert.equal(a.id, '13527749558651');
  assert.equal(a.number, 38014);
  assert.equal(a.createdAt, '2026-11-06T09:00:00.000Z');
  assert.equal(a.financialStatus, 'paid');
  assert.equal(a.fulfillmentStatus, 'unfulfilled');
  assert.deepEqual(a.tags, ['Linc Queue', 'VIP']);
  assert.deepEqual(a.lineItems, [{ sku: 'fg1527D_v1', quantity: 2 }]);
});

test('webhook line items use current_quantity when present (removed items count as 0)', () => {
  const order = fromWebhook(webhook({ line_items: [{ sku: 'A', quantity: 3, current_quantity: 0 }, { sku: 'B', quantity: 1 }] }));
  assert.deepEqual(order.lineItems, [{ sku: 'A', quantity: 0 }, { sku: 'B', quantity: 1 }]);
});

test('webhook fulfillment_status partial maps to partially_fulfilled', () => {
  assert.equal(fromWebhook(webhook({ fulfillment_status: 'partial' })).fulfillmentStatus, 'partially_fulfilled');
});

test('masked email keeps the first letter and the domain', () => {
  assert.equal(maskEmail('jane.doe@example.com'), 'j***@example.com');
  assert.equal(maskEmail(''), null);
  assert.equal(maskEmail(null), null);
});

test('a qualifying order passes every prefilter check', () => {
  const result = prefilter(fromWebhook(webhook()), settings);
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.equal(result.inWindow, true);
  assert.equal(result.hasQualifyingSku, true);
  assert.ok(result.checks.every((c) => c.ok));
});

for (const [name, overrides, reason] of [
  ['before the window', { created_at: '2026-11-06T06:59:59Z' }, 'outside_window'],
  ['at the end (exclusive)', { created_at: '2026-11-06T19:00:00Z' }, 'outside_window'],
  ['no bundle', { line_items: [{ sku: 'OTHER', quantity: 1 }] }, 'no_qualifying_sku'],
  ['bundle removed', { line_items: [{ sku: 'FG1527d_V1', quantity: 1, current_quantity: 0 }] }, 'no_qualifying_sku'],
  ['£34.99', { subtotal_price: '34.99' }, 'subtotal_below_min'],
  ['no customer', { customer: null }, 'no_customer'],
  ['US address', { shipping_address: { country_code: 'US' } }, 'country_not_allowed'],
  ['no shipping address', { shipping_address: null }, 'country_not_allowed'],
  ['customer bought a tray', { line_items: [{ sku: 'FG1527d_V1', quantity: 1 }, { sku: 'gt-tray', quantity: 1 }] }, 'tray_already_bought'],
  ['cancelled', { cancelled_at: '2026-11-06T09:01:00Z' }, 'cancelled'],
  ['Shopify test order', { test: true }, 'test_order'],
]) {
  test(`prefilter rejects: ${name} -> ${reason}`, () => {
    const result = prefilter(fromWebhook(webhook(overrides)), settings);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
  });
}

test('exactly £35 qualifies', () => {
  assert.equal(prefilter(fromWebhook(webhook({ subtotal_price: '35.00' })), settings).ok, true);
});

test('test orders pass when allowTestOrders is on', () => {
  assert.equal(prefilter(fromWebhook(webhook({ test: true })), { ...settings, allowTestOrders: true }).ok, true);
});

const now = new Date('2026-11-06T09:02:00Z');
const fresh = (overrides, ctx = {}) => freshCheck(fromGraphQL(gqlNode(overrides)), settings, { now, ...ctx });

test('fresh check: a paid, routed, unreleased order proceeds', () => {
  assert.equal(fresh({}).action, 'proceed');
});

for (const [name, overrides, reason] of [
  ['cancelled', { cancelledAt: '2026-11-06T09:01:00Z' }, 'cancelled'],
  ['potential fraud', { tags: ['Linc Queue', 'Potential Fraud'] }, 'potential_fraud'],
  ['released to Linc', { tags: ['Linc Auto', 'Linc'] }, 'already_released'],
  ['released to ILG', { tags: ['ILG_RELEASED'] }, 'already_released'],
  ['fulfilled', { displayFulfillmentStatus: 'FULFILLED' }, 'already_fulfilled'],
  ['bundle refunded', { lineItems: { nodes: [{ sku: 'FG1527d_V1', quantity: 2, currentQuantity: 0 }] } }, 'no_longer_eligible'],
  ['subtotal now below min', { currentSubtotalPriceSet: { shopMoney: { amount: '20.0', currencyCode: 'GBP' } } }, 'no_longer_eligible'],
  ['tray already there (not ours)', { lineItems: { nodes: [{ sku: 'FG1527d_V1', quantity: 2, currentQuantity: 2 }, { sku: 'GT-TRAY', quantity: 1, currentQuantity: 1 }] } }, 'tray_already_present'],
]) {
  test(`fresh check skips: ${name}`, () => {
    const result = fresh(overrides);
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, reason);
  });
}

test('fresh check: a missing order is skipped', () => {
  const result = freshCheck(null, settings, { now });
  assert.deepEqual([result.action, result.reason], ['skip', 'order_not_found']);
});

test('"Potential Fraud" with "No Fraud" is not fraud (same rule as linc-app)', () => {
  assert.equal(fresh({ tags: ['Linc Queue', 'Potential Fraud', 'No Fraud'] }).action, 'proceed');
});

test('"Linc Queue" is not a release tag (exact tag match)', () => {
  assert.equal(fresh({ tags: ['Linc Queue'] }).action, 'proceed');
});

test('tray already there after our own commit attempt counts as won', () => {
  const overrides = { lineItems: { nodes: [{ sku: 'FG1527d_V1', quantity: 2, currentQuantity: 2 }, { sku: 'GT-TRAY', quantity: 1, currentQuantity: 1 }] } };
  assert.equal(fresh(overrides, { commitAttempted: true }).action, 'already_present');
});

test('not paid yet waits, then skips after max wait', () => {
  assert.deepEqual(fresh({ displayFinancialStatus: 'PENDING' }), { action: 'wait', reason: 'not_paid', checks: fresh({ displayFinancialStatus: 'PENDING' }).checks });
  const late = fresh({ displayFinancialStatus: 'PENDING' }, { waitStartedAt: '2026-11-06T08:56:00Z' });
  assert.deepEqual([late.action, late.reason], ['skip', 'not_paid']);
});

test('partially refunded counts as paid', () => {
  assert.equal(fresh({ displayFinancialStatus: 'PARTIALLY_REFUNDED' }).action, 'proceed');
});

test('not routed yet waits, then proceeds after max wait', () => {
  assert.deepEqual([fresh({ tags: [] }).action, fresh({ tags: [] }).reason], ['wait', 'not_routed']);
  const late = fresh({ tags: [] }, { waitStartedAt: '2026-11-06T08:56:00Z' });
  assert.deepEqual([late.action, late.reason], ['proceed', 'routing_wait_timeout']);
});

test('no routed tags configured means no wait', () => {
  const result = freshCheck(fromGraphQL(gqlNode({ tags: [] })), { ...settings, routedTags: [] }, { now });
  assert.equal(result.action, 'proceed');
});
