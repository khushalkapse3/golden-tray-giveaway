'use strict';

// Test doubles: an in-memory Store, a fake Shopify (ShopifyOps-shaped) and a controllable clock.

const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { rulesFromEnv } = require('../src/rules');

const T0 = new Date('2026-11-06T09:00:00.000Z');

function webhookPayload(id, overrides = {}) {
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    order_number: id,
    created_at: '2026-11-06T09:00:00Z',
    cancelled_at: null,
    test: false,
    email: `buyer${id}@example.com`,
    tags: '',
    financial_status: 'paid',
    fulfillment_status: null,
    subtotal_price: '54.00',
    current_subtotal_price: '54.00',
    currency: 'GBP',
    customer: { id: 7000 + id, admin_graphql_api_id: `gid://shopify/Customer/${7000 + id}` },
    shipping_address: { country_code: 'GB' },
    line_items: [{ sku: 'FG1527d_V1', quantity: 2, current_quantity: 2 }],
    ...overrides,
  };
}

/** The order as Shopify returns it later (normalised shape), routed by linc-app by default. */
function freshOrder(id, overrides = {}) {
  return {
    id: String(id), gid: `gid://shopify/Order/${id}`, name: `#${id}`, number: id,
    createdAt: '2026-11-06T09:00:00.000Z', cancelled: false, test: false, email: `buyer${id}@example.com`,
    tags: ['Linc Auto', 'Linc Queue'], financialStatus: 'paid', fulfillmentStatus: 'unfulfilled',
    subtotal: 54, currentSubtotal: 54, currency: 'GBP',
    customerId: String(7000 + id), customerGid: `gid://shopify/Customer/${7000 + id}`, country: 'GB',
    lineItems: [{ sku: 'FG1527d_V1', quantity: 2 }],
    ...overrides,
  };
}

function fakeShopify() {
  const shop = {
    orders: new Map(),
    edits: [],
    tags: [],
    getOrderCalls: 0,
    addFreeTrayImpl: null,
    addTagsImpl: null,
    scopes: ['read_orders', 'write_orders', 'write_order_edits', 'read_products', 'write_customers', 'read_customers'],
    variant: { id: 'gid://shopify/ProductVariant/42', sku: 'GT-TRAY', price: '5.00', productTitle: 'Golden Tray', productStatus: 'ACTIVE' },
    webhooks: [],
    recent: [],
    async getOrder(id) {
      shop.getOrderCalls += 1;
      if (shop.getOrderImpl) return shop.getOrderImpl(id);
      return shop.orders.get(String(id)) || null;
    },
    async findOrder(ref) {
      const digits = String(ref).replace(/^#/, '');
      return shop.orders.get(digits) || [...shop.orders.values()].find((o) => o.name === `#${digits}`) || null;
    },
    async addFreeTray(args) {
      shop.edits.push(args);
      if (shop.addFreeTrayImpl) return shop.addFreeTrayImpl(args);
      if (args.beforeCommit) await args.beforeCommit();
      const id = args.orderGid.split('/').pop();
      const order = shop.orders.get(id);
      if (order) order.lineItems = [...order.lineItems, { sku: args.traySku, quantity: 1 }];
      return { ok: true, alreadyPresent: false };
    },
    async addTags(resourceGid, tags) {
      if (shop.addTagsImpl) await shop.addTagsImpl(resourceGid, tags);
      shop.tags.push({ resourceGid, tags });
    },
    async getVariant() { return shop.variant; },
    async getAccessScopes() { return shop.scopes; },
    async getShop() { return { name: 'Staging', myshopifyDomain: 'shop.myshopify.com' }; },
    async listWebhooks() { return shop.webhooks; },
    async createWebhook(uri) { const w = { id: `w${shop.webhooks.length + 1}`, topic: 'ORDERS_CREATE', uri }; shop.webhooks.push(w); return w; },
    async recentOrders() { return shop.recent; },
  };
  return shop;
}

function makeEngine({ settings = {}, random, concurrency = 2, publicUrl = 'https://gt.example.com', rules } = {}) {
  const store = new Store(':memory:', { seed: { traySku: 'GT-TRAY', trayVariantId: '42' } });
  store.writeSettings({ ...store.getSettings(), mode: 'live', ...settings });
  const shopify = fakeShopify();
  const clock = { now: new Date(T0) };
  const rolls = [];
  const engine = new Engine({
    store,
    shopify,
    config: {
      shopify: { domain: 'shop.myshopify.com', adminStoreHandle: 'shop', apiVersion: '2026-10' },
      publicUrl,
      rules: { ...rulesFromEnv({}).rules, ...rules },
      worker: { concurrency },
    },
    clock: () => new Date(clock.now),
    random: (n) => { rolls.push(n); return random ? random(n) : 0; },
    logger: { info() {}, warn() {}, error() {} },
    authMode: 'token',
  });
  const advance = (seconds) => { clock.now = new Date(clock.now.getTime() + seconds * 1000); };
  /** Runs ticks until nothing is due or in flight. */
  const drain = async (maxTicks = 50) => {
    for (let i = 0; i < maxTicks; i += 1) {
      const started = await engine.tick();
      if (!started) break;
    }
  };
  return { store, shopify, engine, clock, advance, drain, rolls };
}

module.exports = { T0, webhookPayload, freshOrder, fakeShopify, makeEngine };
