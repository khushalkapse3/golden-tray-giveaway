'use strict';

// One order shape for both sources: the orders/create webhook (REST JSON) and GraphQL reads.

const toNumber = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
const toIso = (value) => (value ? new Date(value).toISOString() : null);
const legacyId = (gid) => (gid ? String(gid).split('/').pop() : null);

function splitTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  return String(tags || '').split(',').map((t) => t.trim()).filter(Boolean);
}

function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

const REST_FULFILLMENT = { null: 'unfulfilled', fulfilled: 'fulfilled', partial: 'partially_fulfilled', restocked: 'restocked' };

function fromWebhook(payload) {
  const customer = payload.customer || null;
  return {
    id: payload.id !== undefined && payload.id !== null ? String(payload.id) : null,
    gid: payload.admin_graphql_api_id || (payload.id ? `gid://shopify/Order/${payload.id}` : null),
    name: payload.name || null,
    number: toNumber(payload.order_number),
    createdAt: toIso(payload.created_at),
    cancelled: Boolean(payload.cancelled_at),
    test: Boolean(payload.test),
    email: payload.email || customer?.email || null,
    tags: splitTags(payload.tags),
    financialStatus: payload.financial_status ? String(payload.financial_status).toLowerCase() : null,
    fulfillmentStatus: REST_FULFILLMENT[String(payload.fulfillment_status ?? null)] || String(payload.fulfillment_status).toLowerCase(),
    subtotal: toNumber(payload.subtotal_price),
    currentSubtotal: toNumber(payload.current_subtotal_price ?? payload.subtotal_price),
    currency: payload.currency || null,
    customerId: customer?.id !== undefined && customer?.id !== null ? String(customer.id) : null,
    customerGid: customer ? customer.admin_graphql_api_id || `gid://shopify/Customer/${customer.id}` : null,
    country: payload.shipping_address?.country_code ? String(payload.shipping_address.country_code).toUpperCase() : null,
    lineItems: (payload.line_items || []).map((item) => ({
      sku: item.sku || '',
      quantity: Number(item.current_quantity ?? item.quantity ?? 0),
    })),
  };
}

function fromGraphQL(node) {
  if (!node) return null;
  const nameDigits = String(node.name || '').replace(/\D/g, '');
  return {
    id: node.legacyResourceId ? String(node.legacyResourceId) : legacyId(node.id),
    gid: node.id,
    name: node.name || null,
    number: nameDigits ? Number(nameDigits) : null,
    createdAt: toIso(node.createdAt),
    cancelled: Boolean(node.cancelledAt),
    test: Boolean(node.test),
    email: node.email || null,
    tags: splitTags(node.tags),
    financialStatus: node.displayFinancialStatus ? String(node.displayFinancialStatus).toLowerCase() : null,
    fulfillmentStatus: node.displayFulfillmentStatus ? String(node.displayFulfillmentStatus).toLowerCase() : null,
    subtotal: toNumber(node.subtotalPriceSet?.shopMoney?.amount),
    currentSubtotal: toNumber(node.currentSubtotalPriceSet?.shopMoney?.amount ?? node.subtotalPriceSet?.shopMoney?.amount),
    currency: node.subtotalPriceSet?.shopMoney?.currencyCode || null,
    customerId: node.customer ? String(node.customer.legacyResourceId || legacyId(node.customer.id)) : null,
    customerGid: node.customer?.id || null,
    country: node.shippingAddress?.countryCodeV2 || null,
    lineItems: (node.lineItems?.nodes || []).map((item) => ({
      sku: item.sku || '',
      quantity: Number(item.currentQuantity ?? item.quantity ?? 0),
    })),
  };
}

module.exports = { fromWebhook, fromGraphQL, maskEmail, splitTags };
