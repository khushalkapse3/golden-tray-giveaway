'use strict';

// What the app does in Shopify, on top of ShopifyClient.request().

const DOCS = require('./documents');
const { ShopifyError } = require('./client');
const { fromGraphQL } = require('../normalize');

const gid = (type, id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/${type}/${id}`);
const userErrorText = (errors) => errors.map((e) => e.message).join('; ');

class ShopifyOps {
  constructor(client) {
    this.client = client;
  }

  run(name, variables = {}) {
    return this.client.request(DOCS[name], variables, { operation: name, mutation: DOCS[name].startsWith('mutation') });
  }

  async getOrder(id) {
    const data = await this.run('GoldenTrayGetOrder', { id: gid('Order', id) });
    return fromGraphQL(data.order);
  }

  /** "#38014", "38014" (name) or a long numeric / gid order id. */
  async findOrder(ref) {
    const value = String(ref || '').trim();
    if (!value) return null;
    if (value.startsWith('gid://') || /^\d{9,}$/.test(value)) return this.getOrder(value);
    const digits = value.replace(/^#/, '');
    if (!/^\d+$/.test(digits)) return null;
    const data = await this.run('GoldenTrayFindOrder', { query: `name:#${digits}` });
    const node = data.orders.nodes.find((n) => n.name === `#${digits}`) || null;
    return fromGraphQL(node);
  }

  async recentOrders({ since, until, maxPages = 20 }) {
    const query = `created_at:>='${since}' AND created_at:<='${until}'`;
    const orders = [];
    let after = null;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.run('GoldenTrayRecentOrders', { query, after });
      orders.push(...data.orders.nodes.map(fromGraphQL));
      if (!data.orders.pageInfo.hasNextPage) break;
      after = data.orders.pageInfo.endCursor;
    }
    return orders;
  }

  /**
   * Adds one tray at £0 to the order: begin → add variant → 100% discount → commit
   * (notifyCustomer: false). Never commits if an earlier step failed. Never throws:
   * returns {ok:true, alreadyPresent} or {ok:false, step, retryable, error}.
   * beforeCommit() runs right before the commit request, so the caller can record that a
   * commit may have happened if the response is lost.
   */
  async addFreeTray({ orderGid, variantId, traySku, discountDescription, staffNote, beforeCommit }) {
    let step = 'begin';
    const failed = (errors) => ({ ok: false, step, retryable: false, error: userErrorText(errors) });
    try {
      const begin = (await this.run('GoldenTrayEditBegin', { id: orderGid })).orderEditBegin;
      if (begin.userErrors?.length) return failed(begin.userErrors);
      const calculatedOrderId = begin.calculatedOrder.id;
      const traySkuLower = String(traySku).toLowerCase();
      const present = begin.calculatedOrder.lineItems.nodes.some((line) => line.quantity > 0 && String(line.sku || '').toLowerCase() === traySkuLower);
      if (present) return { ok: true, alreadyPresent: true };

      step = 'add_variant';
      const added = (await this.run('GoldenTrayEditAddVariant', { id: calculatedOrderId, variantId: gid('ProductVariant', variantId), quantity: 1 })).orderEditAddVariant;
      if (added.userErrors?.length) return failed(added.userErrors);

      step = 'discount';
      const discounted = (await this.run('GoldenTrayEditAddDiscount', {
        id: calculatedOrderId,
        lineItemId: added.calculatedLineItem.id,
        discount: { percentValue: 100, description: discountDescription },
      })).orderEditAddLineItemDiscount;
      if (discounted.userErrors?.length) return failed(discounted.userErrors);

      step = 'commit';
      if (beforeCommit) await beforeCommit();
      const committed = (await this.run('GoldenTrayEditCommit', { id: calculatedOrderId, notifyCustomer: false, staffNote })).orderEditCommit;
      if (committed.userErrors?.length) return failed(committed.userErrors);
      return { ok: true, alreadyPresent: false, orderName: committed.order?.name };
    } catch (error) {
      return { ok: false, step, retryable: error instanceof ShopifyError ? error.retryable : true, error: error.message };
    }
  }

  async addTags(resourceGid, tags) {
    const result = (await this.run('GoldenTrayTagsAdd', { id: resourceGid, tags })).tagsAdd;
    if (result.userErrors?.length) {
      throw new ShopifyError(`tagsAdd: ${userErrorText(result.userErrors)}`, { code: 'USER_ERROR', userErrors: result.userErrors });
    }
  }

  async getVariant(variantId) {
    const v = (await this.run('GoldenTrayVariant', { id: gid('ProductVariant', variantId) })).productVariant;
    if (!v) return null;
    return { id: v.id, sku: v.sku, price: v.price, productTitle: v.product?.title || null, productStatus: v.product?.status || null };
  }

  async getAccessScopes() {
    return (await this.run('GoldenTrayScopes')).currentAppInstallation.accessScopes.map((s) => s.handle);
  }

  async getShop() {
    return (await this.run('GoldenTrayShop')).shop;
  }

  async listWebhooks() {
    return (await this.run('GoldenTrayWebhooks')).webhookSubscriptions.nodes;
  }

  async createWebhook(uri) {
    const result = (await this.run('GoldenTrayWebhookCreate', { topic: 'ORDERS_CREATE', webhookSubscription: { uri, format: 'JSON' } })).webhookSubscriptionCreate;
    if (result.userErrors?.length) throw new ShopifyError(`webhookSubscriptionCreate: ${userErrorText(result.userErrors)}`, { code: 'USER_ERROR' });
    return result.webhookSubscription;
  }
}

module.exports = { ShopifyOps, gid };
