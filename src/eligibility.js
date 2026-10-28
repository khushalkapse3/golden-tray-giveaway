'use strict';

// Who can win. prefilter() runs on the webhook copy; freshCheck() runs on a fresh Shopify read
// just before the tray is added (tags, payment and release state may have changed by then).

const PAID = new Set(['paid', 'partially_refunded']);
// Fulfillment states where adding a line item still reaches the warehouse.
const EDITABLE_FULFILLMENT = new Set(['unfulfilled', 'open', 'on_hold', 'scheduled', 'pending_fulfillment']);

const lower = (s) => String(s || '').trim().toLowerCase();
const tagSet = (tags) => new Set((tags || []).map(lower));
const hasAnyTag = (tags, wanted) => {
  const have = tagSet(tags);
  return (wanted || []).some((t) => have.has(lower(t)));
};
const hasSku = (lineItems, skus) => {
  const wanted = new Set((skus || []).map(lower).filter(Boolean));
  return (lineItems || []).some((item) => item.quantity > 0 && wanted.has(lower(item.sku)));
};
// Same rule as linc-app lincQueueProcessing.js: held unless someone added "No Fraud".
const isFraud = (tags) => hasAnyTag(tags, ['Potential Fraud']) && !hasAnyTag(tags, ['No Fraud']);

function prefilter(order, settings) {
  const created = order.createdAt ? new Date(order.createdAt).getTime() : NaN;
  const inWindow = created >= new Date(settings.startsAt).getTime() && created < new Date(settings.endsAt).getTime();
  const hasQualifyingSku = hasSku(order.lineItems, settings.qualifyingSkus);
  const checks = [
    { name: 'in_window', reason: 'outside_window', ok: inWindow, detail: `created ${order.createdAt}` },
    { name: 'qualifying_sku', reason: 'no_qualifying_sku', ok: hasQualifyingSku, detail: `needs one of ${settings.qualifyingSkus.join(', ')}` },
    { name: 'min_subtotal', reason: 'subtotal_below_min', ok: order.subtotal !== null && order.subtotal >= settings.minSubtotal, detail: `subtotal ${order.subtotal} ${order.currency || ''} (min ${settings.minSubtotal})` },
    { name: 'customer', reason: 'no_customer', ok: Boolean(order.customerId), detail: order.customerId ? `customer ${order.customerId}` : 'no customer on the order' },
    { name: 'country', reason: 'country_not_allowed', ok: Boolean(order.country) && settings.allowedCountries.includes(order.country), detail: `ships to ${order.country || 'nowhere'}` },
    { name: 'tray_not_bought', reason: 'tray_already_bought', ok: !hasSku(order.lineItems, [settings.traySku]), detail: 'tray not already on the order' },
    { name: 'not_cancelled', reason: 'cancelled', ok: !order.cancelled, detail: order.cancelled ? 'cancelled' : 'open' },
    { name: 'not_test', reason: 'test_order', ok: settings.allowTestOrders || !order.test, detail: order.test ? 'Shopify test order' : 'real order' },
  ];
  const failed = checks.find((c) => !c.ok);
  return {
    ok: !failed,
    reason: failed ? failed.reason : null,
    inWindow,
    hasQualifyingSku,
    checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })),
  };
}

/**
 * action: proceed | skip | wait | already_present
 * ctx: {now, waitStartedAt, commitAttempted}
 */
function freshCheck(order, settings, ctx = {}) {
  const now = ctx.now || new Date();
  if (!order) return { action: 'skip', reason: 'order_not_found', checks: [{ name: 'found', ok: false, detail: 'order not found in Shopify' }] };

  const waited = ctx.waitStartedAt ? now.getTime() - new Date(ctx.waitStartedAt).getTime() : 0;
  const waitedTooLong = waited >= settings.maxWaitSeconds * 1000;
  const trayThere = hasSku(order.lineItems, [settings.traySku]);
  const stillQualifies = hasSku(order.lineItems, settings.qualifyingSkus) && (order.currentSubtotal ?? 0) >= settings.minSubtotal;
  const paid = PAID.has(order.financialStatus);
  const routed = settings.routedTags.length === 0 || hasAnyTag(order.tags, settings.routedTags);

  const checks = [
    { name: 'not_cancelled', ok: !order.cancelled, detail: order.cancelled ? 'cancelled' : 'open' },
    { name: 'not_fraud', ok: !isFraud(order.tags), detail: 'no "Potential Fraud" tag (or "No Fraud" added)' },
    { name: 'not_released', ok: !hasAnyTag(order.tags, settings.releasedTags), detail: `none of: ${settings.releasedTags.join(', ')}` },
    { name: 'not_fulfilled', ok: EDITABLE_FULFILLMENT.has(order.fulfillmentStatus), detail: `fulfillment ${order.fulfillmentStatus}` },
    { name: 'tray_not_present', ok: !trayThere, detail: trayThere ? 'tray already on the order' : 'no tray yet' },
    { name: 'still_qualifies', ok: stillQualifies, detail: `current subtotal ${order.currentSubtotal}` },
    { name: 'paid', ok: paid, detail: `financial status ${order.financialStatus}` },
    { name: 'routed_by_linc', ok: routed, detail: routed ? 'has a linc-app routing tag' : 'no linc-app routing tag yet' },
  ];

  const result = (action, reason) => ({ action, reason, checks });
  if (order.cancelled) return result('skip', 'cancelled');
  if (isFraud(order.tags)) return result('skip', 'potential_fraud');
  if (hasAnyTag(order.tags, settings.releasedTags)) return result('skip', 'already_released');
  if (!EDITABLE_FULFILLMENT.has(order.fulfillmentStatus)) return result('skip', 'already_fulfilled');
  if (trayThere) return ctx.commitAttempted ? result('already_present', 'tray_already_present') : result('skip', 'tray_already_present');
  if (!stillQualifies) return result('skip', 'no_longer_eligible');
  if (!paid) return waitedTooLong ? result('skip', 'not_paid') : result('wait', 'not_paid');
  if (!routed) return waitedTooLong ? result('proceed', 'routing_wait_timeout') : result('wait', 'not_routed');
  return result('proceed', null);
}

module.exports = { prefilter, freshCheck, hasSku, hasAnyTag, isFraud };
