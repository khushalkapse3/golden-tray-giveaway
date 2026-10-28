'use strict';

// A tiny fake of the Shopify Admin GraphQL API: just the operations this app sends, with
// in-memory orders. For local end-to-end tests (scripts/e2e-smoke.js) and dashboard demos:
//
//   node scripts/fake-shopify.js            # port 4200
//   SHOPIFY_BASE_URL=http://127.0.0.1:4200 npm run dev
//
// Orders are "routed by linc-app" (tagged Linc Queue) straight away unless created with tags.

const http = require('node:http');

function createFakeShopify({ domain = 'fake-store.myshopify.com', traySku = 'GT-TRAY', trayVariantId = '42' } = {}) {
  const state = {
    orders: new Map(), // id -> order node (GraphQL shape)
    calculated: new Map(), // calculated order id -> {orderId, added: [{lineId, discount}]}
    commits: [],
    tags: [],
    webhooks: [],
    variant: { id: `gid://shopify/ProductVariant/${trayVariantId}`, sku: traySku, price: '5.00', product: { title: 'Golden Tray', status: 'ACTIVE' } },
    scopes: ['read_orders', 'write_orders', 'write_order_edits', 'read_products', 'write_customers', 'read_customers'],
    requests: 0,
  };
  let seq = 1;

  function addOrder({ id, name, createdAt = new Date().toISOString(), subtotal = '54.00', sku = 'FG1527d_V1', quantity = 2, tags = ['Linc Auto', 'Linc Queue'], financial = 'PAID', country = 'GB', customerId = 7000 + Number(id) }) {
    const node = {
      id: `gid://shopify/Order/${id}`, legacyResourceId: String(id), name: name || `#${id}`, createdAt, cancelledAt: null, test: false,
      email: `buyer${id}@example.com`, tags: [...tags], displayFinancialStatus: financial, displayFulfillmentStatus: 'UNFULFILLED',
      subtotalPriceSet: { shopMoney: { amount: subtotal, currencyCode: 'GBP' } },
      currentSubtotalPriceSet: { shopMoney: { amount: subtotal, currencyCode: 'GBP' } },
      customer: { id: `gid://shopify/Customer/${customerId}`, legacyResourceId: String(customerId) },
      shippingAddress: { countryCodeV2: country },
      lineItems: { nodes: [{ sku, quantity, currentQuantity: quantity, price: subtotal }] },
    };
    state.orders.set(String(id), node);
    return node;
  }

  /** The orders/create webhook body Shopify would send for this order (REST shape). */
  function webhookBody(id) {
    const o = state.orders.get(String(id));
    return {
      id: Number(id), admin_graphql_api_id: o.id, name: o.name, order_number: Number(o.name.replace(/\D/g, '')),
      created_at: o.createdAt, cancelled_at: null, test: false, email: o.email, tags: '',
      financial_status: o.displayFinancialStatus.toLowerCase(), fulfillment_status: null,
      subtotal_price: o.subtotalPriceSet.shopMoney.amount, current_subtotal_price: o.subtotalPriceSet.shopMoney.amount, currency: 'GBP',
      customer: { id: Number(o.customer.legacyResourceId), admin_graphql_api_id: o.customer.id },
      shipping_address: { country_code: o.shippingAddress.countryCodeV2 },
      line_items: o.lineItems.nodes.map((l) => ({ sku: l.sku, quantity: l.quantity, current_quantity: l.currentQuantity })),
    };
  }

  const ok = (payload) => ({ ...payload, userErrors: [] });
  const userError = (message) => ({ userErrors: [{ field: ['id'], message }] });
  const byGid = (gid) => state.orders.get(String(gid).split('/').pop());

  const handlers = {
    GoldenTrayGetOrder: ({ id }) => ({ order: byGid(id) || null }),
    GoldenTrayFindOrder: ({ query }) => ({ orders: { nodes: [...state.orders.values()].filter((o) => `name:${o.name}` === query) } }),
    GoldenTrayRecentOrders: ({ query }) => {
      const [, since, until] = /created_at:>='([^']+)' AND created_at:<='([^']+)'/.exec(query) || [];
      const nodes = [...state.orders.values()].filter((o) => o.createdAt >= since && o.createdAt <= until);
      return { orders: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } };
    },
    GoldenTrayEditBegin: ({ id }) => {
      const order = byGid(id);
      if (!order) return { orderEditBegin: userError('Order does not exist') };
      const calcId = `gid://shopify/CalculatedOrder/${seq++}`;
      state.calculated.set(calcId, { orderId: order.legacyResourceId, added: [] });
      return { orderEditBegin: ok({ calculatedOrder: { id: calcId, lineItems: { nodes: order.lineItems.nodes.map((l, i) => ({ id: `cli${i}`, sku: l.sku, quantity: l.currentQuantity })) } } }) };
    },
    GoldenTrayEditAddVariant: ({ id, variantId, quantity }) => {
      if (variantId !== state.variant.id) return { orderEditAddVariant: userError('The variant does not exist in the shop.') };
      const calc = state.calculated.get(id);
      const lineId = `gid://shopify/CalculatedLineItem/${seq++}`;
      calc.added.push({ lineId, quantity, discount: null });
      return { orderEditAddVariant: ok({ calculatedLineItem: { id: lineId } }) };
    },
    GoldenTrayEditAddDiscount: ({ id, lineItemId, discount }) => {
      const line = state.calculated.get(id).added.find((l) => l.lineId === lineItemId);
      line.discount = discount;
      return { orderEditAddLineItemDiscount: ok({ calculatedLineItem: { id: lineItemId } }) };
    },
    GoldenTrayEditCommit: ({ id, notifyCustomer, staffNote }) => {
      const calc = state.calculated.get(id);
      const order = state.orders.get(calc.orderId);
      for (const line of calc.added) order.lineItems.nodes.push({ sku: state.variant.sku, quantity: line.quantity, currentQuantity: line.quantity, price: '5.00', discount: line.discount });
      state.commits.push({ orderId: calc.orderId, notifyCustomer, staffNote, added: calc.added });
      state.calculated.delete(id);
      return { orderEditCommit: ok({ order: { id: order.id, name: order.name } }) };
    },
    GoldenTrayTagsAdd: ({ id, tags }) => {
      state.tags.push({ id, tags });
      const order = byGid(id);
      if (id.includes('/Order/') && order) order.tags.push(...tags);
      return { tagsAdd: ok({ node: { id } }) };
    },
    GoldenTrayVariant: ({ id }) => ({ productVariant: id === state.variant.id ? state.variant : null }),
    GoldenTrayScopes: () => ({ currentAppInstallation: { accessScopes: state.scopes.map((handle) => ({ handle })) } }),
    GoldenTrayShop: () => ({ shop: { name: 'Fake store', myshopifyDomain: domain } }),
    GoldenTrayWebhooks: () => ({ webhookSubscriptions: { nodes: state.webhooks } }),
    GoldenTrayWebhookCreate: ({ topic, webhookSubscription }) => {
      const w = { id: `gid://shopify/WebhookSubscription/${seq++}`, topic, uri: webhookSubscription.uri };
      state.webhooks.push(w);
      return { webhookSubscriptionCreate: ok({ webhookSubscription: { id: w.id, uri: w.uri } }) };
    },
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.requests += 1;
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/admin/oauth/access_token') return res.end(JSON.stringify({ access_token: 'fake-token', scope: state.scopes.join(','), expires_in: 86399 }));
      if (!/\/admin\/api\/[^/]+\/graphql\.json$/.test(req.url)) { res.statusCode = 404; return res.end('{}'); }
      try {
        const { query, variables } = JSON.parse(body);
        const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
        const handler = handlers[name];
        if (!handler) return res.end(JSON.stringify({ errors: [{ message: `fake-shopify: unknown operation ${name}` }] }));
        return res.end(JSON.stringify({ data: handler(variables || {}) }));
      } catch (error) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ errors: [{ message: error.message }] }));
      }
    });
  });

  return { server, state, addOrder, webhookBody, domain };
}

if (require.main === module) {
  const fake = createFakeShopify({ traySku: process.env.GOLDEN_TRAY_SKU || 'GT-TRAY', trayVariantId: process.env.GOLDEN_TRAY_VARIANT_ID || '42' });
  const port = parseInt(process.env.FAKE_SHOPIFY_PORT, 10) || 4200;
  fake.server.listen(port, () => console.log(`fake Shopify (${fake.domain}) on http://127.0.0.1:${port}`));
}

module.exports = { createFakeShopify };
