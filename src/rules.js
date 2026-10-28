'use strict';

// Fixed rules. Not editable from the dashboard: they depend on how linc-app and the warehouses
// behave, so only a developer changes them (here, or with the env vars below).
//
// How they fit together (checked in linc-app, 2026-10-28):
// - linc-app routes an order (adds one of routedTags) a few seconds after orders/create.
// - Linc and ILG release an order to the warehouse at least 10 minutes after it was created.
// - So the tray must be on the order well before that: delay + max wait + retries must end
//   at least 2 minutes before the release (RELEASE_SAFETY_LIMIT_SECONDS).

const RULES = Object.freeze({
  // Wait before rolling, so linc-app has routed the order first.
  delaySeconds: 60,
  // If the order still has no routing tag after this, add the tray anyway (Linc re-reads the
  // order from Shopify when it releases it, so the tray still ships).
  maxWaitSeconds: 180,
  // linc-app only re-routes an updated order once it has one of these tags
  // (linc-app src/queues/processors/routing.js, "hasPartnerTags").
  routedTags: Object.freeze(['Linc Manual', 'Linc Queue', 'Wonderpack Fulfilment Queue', 'Wonderpack Helm Queue', 'Synergy Fulfilment Queue', 'ILG Fulfilment Queue', 'ShipHero Queue']),
  // Tags linc-app adds when an order is handed to a warehouse (linc-app src/constants.js PARTNERS).
  releasedTags: Object.freeze(['Linc', 'ILG_RELEASED', 'Synergy Fulfilment', 'Wonderpack Fulfilment']),
});

// Waits between tray attempts when one fails for a reason that may pass (network, 5xx, throttle).
const AWARD_BACKOFF_SECONDS = [30, 90, 270];
const MAX_AWARD_ATTEMPTS = 3;
// A Shopify order edit is four calls, about 2 s. Budget 20 s per attempt.
const ATTEMPT_ALLOWANCE_SECONDS = 20;
const RELEASE_SAFETY_LIMIT_SECONDS = 480;

/** Longest time from order creation until the last attempt can finish. */
function worstCaseSeconds(rules) {
  const waits = AWARD_BACKOFF_SECONDS.slice(0, MAX_AWARD_ATTEMPTS - 1).reduce((a, b) => a + b, 0);
  return rules.delaySeconds + rules.maxWaitSeconds + waits + MAX_AWARD_ATTEMPTS * ATTEMPT_ALLOWANCE_SECONDS;
}

function whole(value, name, min, max, errors) {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name} must be a whole number between ${min} and ${max}`);
    return null;
  }
  return n;
}

function rulesFromEnv(env = process.env) {
  const errors = [];
  const rules = { ...RULES, routedTags: [...RULES.routedTags], releasedTags: [...RULES.releasedTags] };
  const delay = whole(env.DELAY_SECONDS, 'DELAY_SECONDS', 0, 300, errors);
  const wait = whole(env.MAX_WAIT_SECONDS, 'MAX_WAIT_SECONDS', 0, 600, errors);
  if (delay !== null) rules.delaySeconds = delay;
  if (wait !== null) rules.maxWaitSeconds = wait;
  if (errors.length === 0 && worstCaseSeconds(rules) > RELEASE_SAFETY_LIMIT_SECONDS) {
    errors.push(`DELAY_SECONDS + MAX_WAIT_SECONDS is too long: in the worst case the tray would be added ${worstCaseSeconds(rules)} s after the order, and Linc releases orders after 600 s (limit ${RELEASE_SAFETY_LIMIT_SECONDS} s)`);
  }
  return { rules, errors };
}

module.exports = { RULES, AWARD_BACKOFF_SECONDS, MAX_AWARD_ATTEMPTS, ATTEMPT_ALLOWANCE_SECONDS, RELEASE_SAFETY_LIMIT_SECONDS, worstCaseSeconds, rulesFromEnv };
