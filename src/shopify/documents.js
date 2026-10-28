'use strict';

// Every GraphQL document the app sends (Admin API 2026-10). Checked against the 2026-10 schema
// by scripts/validate-graphql.js. The key of each entry is also its operation name.

const ORDER_FIELDS = `
  id
  legacyResourceId
  name
  createdAt
  cancelledAt
  test
  email
  tags
  displayFinancialStatus
  displayFulfillmentStatus
  subtotalPriceSet { shopMoney { amount currencyCode } }
  currentSubtotalPriceSet { shopMoney { amount currencyCode } }
  customer { id legacyResourceId }
  shippingAddress { countryCodeV2 }
`;

module.exports = {
  GoldenTrayGetOrder: `query GoldenTrayGetOrder($id: ID!) {
  order(id: $id) {
    ${ORDER_FIELDS}
    lineItems(first: 100) { nodes { sku quantity currentQuantity } }
  }
}`,

  GoldenTrayFindOrder: `query GoldenTrayFindOrder($query: String!) {
  orders(first: 1, query: $query) {
    nodes {
      ${ORDER_FIELDS}
      lineItems(first: 100) { nodes { sku quantity currentQuantity } }
    }
  }
}`,

  // Backfill: 20 orders x 25 lines keeps the requested cost well under the 1000-point limit.
  GoldenTrayRecentOrders: `query GoldenTrayRecentOrders($query: String!, $after: String) {
  orders(first: 20, after: $after, query: $query, sortKey: CREATED_AT) {
    nodes {
      ${ORDER_FIELDS}
      lineItems(first: 25) { nodes { sku quantity currentQuantity } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`,

  GoldenTrayEditBegin: `mutation GoldenTrayEditBegin($id: ID!) {
  orderEditBegin(id: $id) {
    calculatedOrder {
      id
      lineItems(first: 250) { nodes { id sku quantity } }
    }
    userErrors { field message }
  }
}`,

  GoldenTrayEditAddVariant: `mutation GoldenTrayEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
  orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
    calculatedLineItem { id }
    userErrors { field message }
  }
}`,

  GoldenTrayEditAddDiscount: `mutation GoldenTrayEditAddDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
  orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
    calculatedLineItem { id }
    userErrors { field message }
  }
}`,

  GoldenTrayEditCommit: `mutation GoldenTrayEditCommit($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
  orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
    order { id name }
    userErrors { field message }
  }
}`,

  GoldenTrayTagsAdd: `mutation GoldenTrayTagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    node { id }
    userErrors { field message }
  }
}`,

  GoldenTrayVariant: `query GoldenTrayVariant($id: ID!) {
  productVariant(id: $id) {
    id
    sku
    price
    product { title status }
  }
}`,

  GoldenTrayScopes: `query GoldenTrayScopes {
  currentAppInstallation { accessScopes { handle } }
}`,

  GoldenTrayShop: `query GoldenTrayShop {
  shop { name myshopifyDomain }
}`,

  GoldenTrayWebhooks: `query GoldenTrayWebhooks {
  webhookSubscriptions(first: 50, topics: [ORDERS_CREATE]) {
    nodes { id topic uri }
  }
}`,

  GoldenTrayWebhookCreate: `mutation GoldenTrayWebhookCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id uri }
    userErrors { field message }
  }
}`,
};
