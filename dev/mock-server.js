'use strict';
/*
 * Golden tray dashboard: mock API server for front-end development.
 *
 *   node dev/mock-server.js            (port 4100, or PORT env)
 *
 * Node built-ins only. Serves ../public and fakes every /api endpoint in API.md
 * with in-memory data that keeps changing. Login password: "dev".
 *
 * Env knobs:
 *   MOCK_NOW    ISO time the fake clock starts at (default 2026-11-06T09:00:00Z, inside the window)
 *   MOCK_SPEED  clock speed multiplier (default 1 = real time)
 *   MOCK_MODE   initial mode: off | shadow | live (default shadow)
 *   MOCK_RATE   candidate orders per hour (default 900)
 *
 * The fake clock is what /api/status returns as "now", so the UI must use the
 * server's clock (not the browser's) for countdowns.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 4100;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PASSWORD = 'dev';
const BEARER = 'dev-token';
const SPEED = Number(process.env.MOCK_SPEED) || 1;
const CLOCK_START = Date.parse(process.env.MOCK_NOW || '2026-11-06T09:00:00.000Z');
const BOOT = Date.now();
const RATE = Number(process.env.MOCK_RATE) || 900;
const STORE = 'staging-purdy-global';
const ADMIN_ORDERS_URL = `https://admin.shopify.com/store/${STORE}/orders/`;

const now = () => CLOCK_START + (Date.now() - BOOT) * SPEED;
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- state

const DEFAULT_VARIANT = '51234567890123';
const settings = {
  campaignName: 'Golden tray giveaway',
  mode: ['off', 'shadow', 'live'].includes(process.env.MOCK_MODE) ? process.env.MOCK_MODE : 'shadow',
  startsAt: '2026-11-06T07:00:00.000Z',
  endsAt: '2026-11-06T19:00:00.000Z',
  oneInN: 20,
  cap: 500,
  estimatedOrders: 10000,
  minSubtotal: 35,
  delaySeconds: 60,
  maxWaitSeconds: 300,
  autoPace: false,
  autoPaceEveryMinutes: 15,
  autoPaceMinN: 1,
  autoPaceMaxN: 200,
  backfill: true,
  traySku: 'GOLDEN-TRAY-01',
  trayVariantId: DEFAULT_VARIANT,
  qualifyingSkus: ['FG1527d_V1'],
  tag: 'GoldenTrayNov2026',
  allowedCountries: ['GB', 'GG', 'JE', 'IM'],
  routedTags: ['Linc Manual', 'Linc Queue', 'Wonderpack Fulfilment Queue', 'Wonderpack Helm Queue',
    'Synergy Fulfilment Queue', 'ILG Fulfilment Queue', 'ShipHero Queue'],
  releasedTags: ['Linc', 'ILG_RELEASED', 'Synergy Fulfilment', 'Wonderpack Fulfilment'],
  discountDescription: 'Golden tray: free gift',
};
const LOCKED = ['traySku', 'trayVariantId', 'qualifyingSkus', 'tag', 'allowedCountries', 'routedTags', 'releasedTags'];

let webhook = { registered: process.env.MOCK_MODE === 'live', id: null, uri: null };
let setupCache = null;
const orders = []; // newest last
const byId = new Map();
const events = []; // oldest first
let nextEventId = 1;
let seq = 0;
const autoPace = { lastRunAt: null, lastChange: null };
const backfill = { lastRunAt: null, lastFound: 0, lastError: null };
const worker = { lastTickAt: null };
const sessions = new Map();
const loginAttempts = new Map();

// ---------------------------------------------------------------- helpers

function rand(min, max) { return min + Math.random() * (max - min); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function round2(n) { return Math.round(n * 100) / 100; }

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DOMAINS = ['gmail.com', 'hotmail.co.uk', 'outlook.com', 'yahoo.co.uk', 'icloud.com', 'btinternet.com', 'example.com'];

function addEvent(level, type, message, extra = {}) {
  const ev = {
    id: nextEventId++, at: iso(extra.at || now()), level, type,
    orderId: extra.order ? extra.order.id : null,
    orderName: extra.order ? extra.order.name : null,
    actor: extra.actor || 'system', message,
  };
  events.push(ev);
  if (events.length > 5000) events.splice(0, events.length - 5000);
  return ev;
}

function makeOrder(createdAt, source = 'webhook') {
  seq += 1;
  const number = 38000 + seq;
  const id = String(13527749558000 + seq * 7);
  const roll = Math.random();
  const subtotal = round2(roll < 0.12 ? rand(18, 34.99) : pick([39, 44, 54, 54, 59.5, 64, 72, 89, 108]) + (Math.random() < 0.3 ? rand(0, 30) : 0));
  const country = Math.random() < 0.94 ? 'GB' : pick(['IE', 'JE', 'GG', 'IM', 'FR', 'US']);
  const hasCustomer = Math.random() > 0.015;
  const o = {
    id, name: `#${number}`, number,
    createdAt: iso(createdAt), receivedAt: iso(createdAt + rand(1000, 4000)),
    source, subtotal, currency: 'GBP',
    customerId: hasCustomer ? String(8812345000000 + seq * 3) : null,
    customerEmail: hasCustomer ? `${pick(LETTERS)}***@${pick(DOMAINS)}` : null,
    country,
    status: 'queued', reason: null, mode: null, slot: null, rollN: null, attempts: 0,
    lastError: null, trayAddedAt: null, tagStatus: null, updatedAt: iso(createdAt),
    adminUrl: ADMIN_ORDERS_URL + id,
    // internal (stripped before sending)
    _processAfter: createdAt + settings.delaySeconds * 1000,
    _awardDoneAt: null,
    _trayBought: Math.random() < 0.01,
    _tagRetries: 0,
  };
  return o;
}

function publicOrder(o) {
  const out = {};
  for (const k of Object.keys(o)) if (!k.startsWith('_')) out[k] = o[k];
  return out;
}

function prefilter(o) {
  const t = Date.parse(o.createdAt);
  if (t < Date.parse(settings.startsAt) || t >= Date.parse(settings.endsAt)) return 'outside_window';
  if (o.subtotal < settings.minSubtotal) return 'subtotal_below_min';
  if (!o.customerId) return 'no_customer';
  if (!settings.allowedCountries.includes(o.country)) return 'country_not_allowed';
  if (o._trayBought) return 'tray_already_bought';
  return null;
}

function receive(o, at) {
  if (settings.mode === 'off') return null; // not stored
  const reason = prefilter(o);
  if (reason === 'outside_window') return null;
  if (reason) {
    o.status = 'not_eligible'; o.reason = reason; o.mode = settings.mode; o.updatedAt = iso(at);
  } else {
    o._processAfter = at + settings.delaySeconds * 1000;
  }
  orders.push(o);
  byId.set(o.id, o);
  return o;
}

function winnersCount(mode) {
  let n = 0;
  for (const o of orders) {
    if (mode === 'live' && o.mode === 'live' && (o.status === 'won' || o.status === 'awarding')) n++;
    if (mode === 'shadow' && o.mode === 'shadow' && o.status === 'shadow_won') n++;
  }
  return n;
}

function nextSlot(mode) {
  let max = 0;
  for (const o of orders) if (o.mode === mode && o.slot && o.slot > max) max = o.slot;
  return max + 1;
}

function decide(o, at, instant) {
  const mode = settings.mode;
  o.updatedAt = iso(at);
  if (mode === 'off') { o.status = 'skipped'; o.reason = 'campaign_off'; o.mode = null; return; }
  o.mode = mode;
  if (winnersCount(mode) >= settings.cap) { o.status = 'cap_reached'; return; }
  o.rollN = settings.oneInN;
  o.attempts += 1;
  if (crypto.randomInt(settings.oneInN) !== 0) { o.status = 'lost'; return; }
  if (mode === 'shadow') {
    o.status = 'shadow_won'; o.slot = nextSlot('shadow');
    addEvent('info', 'won', `Shadow winner, slot ${o.slot} (1 in ${o.rollN}). No Shopify writes.`, { order: o, at });
    return;
  }
  o.status = 'awarding';
  o._awardDoneAt = at + (instant ? 0 : rand(1500, 4500));
  if (instant) finishAward(o, at);
}

function finishAward(o, at) {
  const r = Math.random();
  o.updatedAt = iso(at);
  o._awardDoneAt = null;
  if (r < 0.03) {
    o.status = 'failed'; o.attempts = 3;
    o.lastError = pick([
      'orderEditCommit: THROTTLED after 3 attempts (Shopify returned 429 Too Many Requests on the final retry)',
      'orderEditAddVariant: userErrors[0] Variant is not available for sale on the online store channel',
      'fetch failed: ECONNRESET while reading order from Shopify',
    ]);
    addEvent('error', 'award_failed', `Award failed: ${o.lastError}`, { order: o, at });
    return;
  }
  if (r < 0.06) {
    o.status = 'skipped'; o.reason = pick(['potential_fraud', 'already_released', 'cancelled', 'not_paid_in_time']);
    addEvent('warn', 'skipped', `Skipped after winning roll: ${o.reason}. Slot freed.`, { order: o, at });
    return;
  }
  o.status = 'won'; o.slot = nextSlot('live'); o.trayAddedAt = iso(at);
  o.tagStatus = Math.random() < 0.04 ? 'failed' : 'ok';
  if (o.tagStatus === 'failed') o.lastError = 'tagsAdd: Customer tag write failed (THROTTLED)';
  addEvent('info', 'won', `Winner, slot ${o.slot}. Tray added at £0 and tagged ${settings.tag}.`, { order: o, at });
  if (o.tagStatus === 'failed') addEvent('warn', 'tag_failed', 'Tagging failed; will retry every minute (up to 5).', { order: o, at });
}

// ---------------------------------------------------------------- derived

function activeMode() { return settings.mode === 'off' ? null : settings.mode; }

function emptyCounts() {
  return { received: 0, queued: 0, not_eligible: 0, eligible: 0, lost: 0, cap_reached: 0,
    awarding: 0, won: 0, skipped: 0, failed: 0, tag_failed: 0 };
}

function counts() {
  const out = { live: emptyCounts(), shadow: emptyCounts() };
  const cur = activeMode() || 'live';
  for (const o of orders) {
    const m = o.status === 'queued' ? cur : (o.mode || 'live');
    const c = out[m];
    c.received++;
    const st = o.status === 'shadow_won' ? 'won' : o.status;
    if (c[st] !== undefined) c[st]++;
    if (o.rollN != null) c.eligible++;
    if (o.status === 'won' && o.tagStatus === 'failed') c.tag_failed++;
  }
  return out;
}

function windowInfo() {
  const t = now();
  const s = Date.parse(settings.startsAt);
  const e = Date.parse(settings.endsAt);
  const totalHours = (e - s) / 3600000;
  const hoursElapsed = Math.min(totalHours, Math.max(0, (t - s) / 3600000));
  return {
    startsAt: settings.startsAt, endsAt: settings.endsAt,
    state: t < s ? 'not_started' : t < e ? 'open' : 'ended',
    totalHours: round2(totalHours), hoursElapsed: round2(hoursElapsed),
    hoursLeft: round2(totalHours - hoursElapsed),
    msToStart: Math.max(0, s - t), msToEnd: Math.max(0, e - t),
  };
}

function pacing() {
  const w = windowInfo();
  const m = activeMode() || 'live';
  const c = counts()[m];
  const candidates = c.eligible + c.queued;
  const observed = w.hoursElapsed >= 0.5;
  const ratePerHour = observed ? candidates / w.hoursElapsed : settings.estimatedOrders / w.totalHours;
  const hoursLeft = w.state === 'not_started' ? w.totalHours : w.hoursLeft;
  const expectedRemainingOrders = Math.round(ratePerHour * hoursLeft) + c.queued;
  const winners = c.won + c.awarding;
  const left = Math.max(0, settings.cap - winners);
  const suggested = left > 0 ? Math.max(1, Math.floor(expectedRemainingOrders / left)) : null;
  const projected = Math.min(settings.cap, Math.round(winners + expectedRemainingOrders / settings.oneInN));
  return {
    oneInN: settings.oneInN, probabilityPct: round2(100 / settings.oneInN),
    suggestedOneInN: suggested, ratePerHour: Math.round(ratePerHour * 10) / 10,
    basis: observed ? 'observed' : 'estimate',
    expectedRemainingOrders, projectedWinners: projected,
    autoPace: { enabled: settings.autoPace, lastRunAt: autoPace.lastRunAt, lastChange: autoPace.lastChange },
    _traysLeft: left,
  };
}

function runSetupChecks() {
  const checks = [
    { name: 'Access token scopes', ok: true, detail: 'read_orders, write_orders, write_order_edits, read_products, write_customers' },
    {
      name: 'Tray variant exists and is ACTIVE',
      ok: settings.trayVariantId === DEFAULT_VARIANT,
      detail: settings.trayVariantId === DEFAULT_VARIANT
        ? `gid://shopify/ProductVariant/${settings.trayVariantId}, product status ACTIVE`
        : `Variant ${settings.trayVariantId} not found in the store`,
    },
    {
      name: 'Tray variant SKU matches',
      ok: settings.traySku === 'GOLDEN-TRAY-01',
      detail: settings.traySku === 'GOLDEN-TRAY-01' ? 'GOLDEN-TRAY-01' : `Variant SKU is GOLDEN-TRAY-01, setting is ${settings.traySku}`,
    },
    { name: 'Qualifying SKUs exist', ok: true, detail: settings.qualifyingSkus.join(', ') },
    {
      name: 'Webhook orders/create registered',
      ok: webhook.registered,
      detail: webhook.registered ? webhook.uri : 'No orders/create subscription points at this app',
    },
  ];
  const ok = checks.every((c) => c.ok);
  setupCache = {
    ok, checkedAt: iso(now()),
    problems: checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
    checks,
  };
  return setupCache;
}

function status() {
  const p = pacing();
  const traysLeft = p._traysLeft;
  delete p._traysLeft;
  const live = orders.filter((o) => o.status === 'awarding').length;
  return {
    now: iso(now()),
    version: '1.0.0-mock',
    settings: { ...settings },
    lockedWhileLive: LOCKED,
    window: windowInfo(),
    counts: counts(),
    activeMode: activeMode(),
    traysLeft,
    pacing: p,
    worker: {
      running: true, lastTickAt: worker.lastTickAt,
      queued: orders.filter((o) => o.status === 'queued').length,
      awarding: live,
      tagRetriesPending: orders.filter((o) => o.tagStatus === 'failed' || o.tagStatus === 'pending').length,
    },
    backfill: { enabled: settings.backfill, ...backfill },
    shopify: { store: `${STORE}.myshopify.com`, adminOrdersUrl: ADMIN_ORDERS_URL, apiVersion: '2026-10', authMode: 'client_credentials' },
    setup: { ok: setupCache.ok, checkedAt: setupCache.checkedAt, problems: setupCache.problems },
  };
}

// ---------------------------------------------------------------- simulation

function hourlyRate(at) {
  // busier around lunch and early evening
  const h = new Date(at).getUTCHours() + new Date(at).getUTCMinutes() / 60;
  return RATE * (0.75 + 0.35 * Math.exp(-((h - 12.5) ** 2) / 4) + 0.25 * Math.exp(-((h - 18) ** 2) / 2));
}

function poisson(lambda) {
  let L = Math.exp(-lambda), k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function seed() {
  const start = Date.parse(settings.startsAt);
  const t0 = now();
  if (t0 <= start) return;
  const realMode = settings.mode;
  for (const mode of ['live', 'shadow']) {
    settings.mode = mode;
    const factor = 1;
    for (let t = start; t < t0; t += 60000) {
      const n = poisson((hourlyRate(t) * factor) / 60);
      for (let i = 0; i < n; i++) {
        const at = t + Math.random() * 60000;
        const o = receive(makeOrder(at), at);
        if (o && o.status === 'queued' && o._processAfter < t0) decide(o, o._processAfter, true);
      }
    }
  }
  settings.mode = realMode;
  orders.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  events.forEach((e, i) => { e.id = i + 1; });
  nextEventId = events.length + 1;
  addEvent('info', 'settings', 'Mode set to live', { actor: 'Murshid', at: start - 600000 });
  addEvent('warn', 'mode', `Mode changed live → ${realMode}`, { actor: 'Khushal', at: t0 - 120000 });
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  events.forEach((e, i) => { e.id = i + 1; });
  nextEventId = events.length + 1;
}

let lastSim = now();
function simTick() {
  const t = now();
  const dt = t - lastSim;
  lastSim = t;
  worker.lastTickAt = iso(t);
  const w = windowInfo();

  // arrivals
  if (w.state === 'open' && settings.mode !== 'off') {
    const n = poisson((hourlyRate(t) * dt) / 3600000);
    for (let i = 0; i < n; i++) receive(makeOrder(t - Math.random() * dt), t);
  }

  // worker
  for (const o of orders) {
    if (o.status === 'queued' && o._processAfter <= t) decide(o, t, false);
    else if (o.status === 'awarding' && o._awardDoneAt && o._awardDoneAt <= t) finishAward(o, t);
    else if (o.tagStatus === 'pending' && o._tagRetryAt && o._tagRetryAt <= t) {
      o.tagStatus = Math.random() < 0.85 ? 'ok' : 'failed';
      o._tagRetries++;
      if (o.tagStatus === 'ok') { o.lastError = null; addEvent('info', 'tags_ok', 'Tags added on retry.', { order: o }); }
      else addEvent('warn', 'tag_failed', `Tag retry ${o._tagRetries} failed.`, { order: o });
      o.updatedAt = iso(t);
    }
  }

  // backfill every 2 min
  if (settings.backfill && (!backfill.lastRunAt || t - Date.parse(backfill.lastRunAt) >= 120000)) {
    backfill.lastRunAt = iso(t);
    backfill.lastFound = 0;
    backfill.lastError = null;
    if (w.state === 'open' && settings.mode !== 'off' && Math.random() < 0.2) {
      const o = receive(makeOrder(t - rand(60000, 600000), 'backfill'), t);
      if (o) { backfill.lastFound = 1; addEvent('info', 'backfill', 'Backfill found an order the webhook missed.', { order: o }); }
    }
  }

  // auto-pace
  if (settings.autoPace && w.state === 'open' &&
      (!autoPace.lastRunAt || t - Date.parse(autoPace.lastRunAt) >= settings.autoPaceEveryMinutes * 60000)) {
    autoPace.lastRunAt = iso(t);
    const p = pacing();
    if (p.suggestedOneInN != null) {
      const to = Math.min(settings.autoPaceMaxN, Math.max(settings.autoPaceMinN, p.suggestedOneInN));
      if (to !== settings.oneInN) {
        autoPace.lastChange = { from: settings.oneInN, to, at: iso(t) };
        addEvent('info', 'auto_pace', `Auto-pace changed N ${settings.oneInN} → ${to}`, { actor: 'auto-pace' });
        settings.oneInN = to;
      }
    }
  }
}

// ---------------------------------------------------------------- settings validation

const isInt = (v) => Number.isInteger(v);
function validate(key, v) {
  const range = (lo, hi) => isInt(v) && v >= lo && v <= hi;
  const strList = () => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim());
  switch (key) {
    case 'campaignName': return typeof v === 'string' && v.trim().length >= 1 && v.length <= 80 ? null : 'Must be 1–80 characters';
    case 'discountDescription': return typeof v === 'string' && v.trim().length >= 1 && v.length <= 80 ? null : 'Must be 1–80 characters';
    case 'mode': return ['off', 'shadow', 'live'].includes(v) ? null : 'Must be off, shadow or live';
    case 'startsAt': case 'endsAt':
      return typeof v === 'string' && !Number.isNaN(Date.parse(v)) && v.endsWith('Z') ? null : 'Must be an ISO-8601 UTC time';
    case 'oneInN': return range(1, 1e9) ? null : 'Must be a whole number, at least 1';
    case 'cap': return range(0, 1e9) ? null : 'Must be a whole number, 0 or more';
    case 'estimatedOrders': return range(1, 1e9) ? null : 'Must be a whole number, at least 1';
    case 'minSubtotal': return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? null : 'Must be a number, 0 or more';
    case 'delaySeconds': return range(0, 600) ? null : 'Must be 0–600 seconds';
    case 'maxWaitSeconds': return range(0, 1800) ? null : 'Must be 0–1800 seconds';
    case 'autoPace': case 'backfill': return typeof v === 'boolean' ? null : 'Must be true or false';
    case 'autoPaceEveryMinutes': return range(5, 120) ? null : 'Must be 5–120 minutes';
    case 'autoPaceMinN': case 'autoPaceMaxN': return range(1, 10000) ? null : 'Must be 1–10000';
    case 'traySku': case 'tag': return typeof v === 'string' && v.trim() ? null : 'Required';
    case 'trayVariantId': return typeof v === 'string' && /^\d+$/.test(v) ? null : 'Must be a numeric variant id';
    case 'qualifyingSkus': return strList() && v.length >= 1 ? null : 'At least one SKU';
    case 'allowedCountries': return strList() && v.length >= 1 && v.every((c) => /^[A-Z]{2}$/.test(c)) ? null : 'ISO-2 country codes, e.g. GB, JE';
    case 'routedTags': case 'releasedTags': return strList() ? null : 'List of tags';
    default: return 'Unknown setting';
  }
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function patchSettings(body, actor) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [400, { error: 'invalid', field: null, message: 'Body must be an object' }];
  const keys = Object.keys(body);
  for (const k of keys) {
    const msg = validate(k, body[k]);
    if (msg) return [400, { error: 'invalid', field: k, message: msg }];
  }
  const next = { ...settings, ...body };
  if (Date.parse(next.endsAt) <= Date.parse(next.startsAt)) {
    return [400, { error: 'invalid', field: body.endsAt !== undefined ? 'endsAt' : 'startsAt', message: 'Window end must be after start' }];
  }
  if (next.autoPaceMinN > next.autoPaceMaxN) {
    return [400, { error: 'invalid', field: body.autoPaceMinN !== undefined ? 'autoPaceMinN' : 'autoPaceMaxN', message: 'Min N must be ≤ max N' }];
  }
  if (settings.mode === 'live') {
    for (const k of keys) if (LOCKED.includes(k) && !same(body[k], settings[k])) return [409, { error: 'locked_while_live', field: k }];
  }
  if (body.mode === 'live' && settings.mode !== 'live') {
    const s = runSetupChecks();
    if (!s.ok) return [409, { error: 'setup_incomplete', problems: s.problems }];
  }
  const warnings = [];
  const changed = [];
  for (const k of keys) {
    if (!same(settings[k], body[k])) { changed.push(`${k} ${JSON.stringify(settings[k])} → ${JSON.stringify(body[k])}`); settings[k] = body[k]; }
  }
  if (changed.length) {
    const isMode = keys.length === 1 && keys[0] === 'mode';
    addEvent(isMode && body.mode === 'live' ? 'warn' : 'info', isMode ? 'mode' : 'settings',
      isMode ? `Mode changed to ${body.mode}` : `Changed ${changed.join('; ')}`, { actor });
  }
  if (['traySku', 'trayVariantId', 'qualifyingSkus'].some((k) => keys.includes(k))) runSetupChecks();
  const p = pacing();
  const c = counts()[activeMode() || 'live'];
  if (keys.includes('oneInN') || keys.includes('cap')) {
    if (settings.cap < c.won) warnings.push(`The cap (${settings.cap}) is below the winners so far (${c.won}); no more trays will be given.`);
    const raw = c.won + p.expectedRemainingOrders / settings.oneInN;
    if (raw > settings.cap * 1.1) warnings.push(`At 1 in ${settings.oneInN} about ${Math.round(raw)} winners are expected; the cap (${settings.cap}) will stop the giveaway before the window ends.`);
    else if (raw < settings.cap * 0.85) warnings.push(`At 1 in ${settings.oneInN} only about ${Math.round(raw)} of ${settings.cap} trays are expected to go.`);
  }
  if (keys.includes('oneInN') && settings.autoPace) warnings.push(`Auto-pace is on and will override N every ${settings.autoPaceEveryMinutes} min.`);
  if (keys.includes('mode') && body.mode === 'live' && windowInfo().state === 'ended') warnings.push('The window has ended; no orders will qualify.');
  return [200, { settings: { ...settings }, warnings }];
}

// ---------------------------------------------------------------- order check

function checkOrder(q) {
  const s = String(q || '').trim().replace(/^#/, '');
  if (!s) return [400, { error: 'invalid', field: 'order', message: 'Enter an order number or id' }];
  let o = orders.find((x) => x.id === s || String(x.number) === s);
  let stored = o || null;
  if (!o) {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 30000 || (n > 38000 + seq + 50 && s.length < 10)) return [404, { error: 'not_found', message: `Order ${q} was not found in Shopify` }];
    o = makeOrder(now() - rand(60000, 7200000)); seq -= 1;
    o.name = `#${n}`; o.number = n;
  }
  const t = Date.parse(o.createdAt);
  const fraud = o.reason === 'potential_fraud';
  const checks = [
    { name: 'Created inside the window', ok: t >= Date.parse(settings.startsAt) && t < Date.parse(settings.endsAt), detail: `Created ${o.createdAt}` },
    { name: 'Contains a qualifying SKU', ok: true, detail: `${settings.qualifyingSkus[0]} × 1` },
    { name: `Subtotal ≥ £${settings.minSubtotal}`, ok: o.subtotal >= settings.minSubtotal, detail: `£${o.subtotal.toFixed(2)}` },
    { name: 'Has a customer', ok: !!o.customerId, detail: o.customerId ? o.customerEmail : 'Guest order with no customer record' },
    { name: 'Country allowed', ok: settings.allowedCountries.includes(o.country), detail: o.country },
    { name: 'Tray not already on order', ok: !o._trayBought && o.status !== 'won', detail: o.status === 'won' ? 'Tray already added by this app' : 'No tray line' },
    { name: 'Not cancelled', ok: o.reason !== 'cancelled', detail: o.reason === 'cancelled' ? 'Cancelled' : 'Open' },
    { name: 'Paid', ok: o.reason !== 'not_paid_in_time', detail: o.reason === 'not_paid_in_time' ? 'PENDING' : 'PAID' },
    { name: 'Not Potential Fraud', ok: !fraud, detail: fraud ? 'Tagged Potential Fraud' : 'No fraud tags' },
    { name: 'Not released to a warehouse', ok: o.reason !== 'already_released', detail: o.reason === 'already_released' ? 'Tagged Linc' : 'Tagged Linc Queue' },
  ];
  return [200, {
    order: { id: o.id, name: o.name, number: o.number, createdAt: o.createdAt, subtotal: o.subtotal, currency: 'GBP',
      customerEmail: o.customerEmail, country: o.country, adminUrl: o.adminUrl },
    checks, eligible: checks.every((c) => c.ok), stored: stored ? publicOrder(stored) : null,
  }];
}

// ---------------------------------------------------------------- timeline

function timeline(bucketMinutes) {
  const m = activeMode() || 'live';
  const s = Date.parse(settings.startsAt);
  const e = Date.parse(settings.endsAt);
  const t = Math.min(now(), e);
  const size = bucketMinutes * 60000;
  const buckets = [];
  for (let b = s; b < t; b += size) buckets.push({ start: iso(b), eligible: 0, winners: 0, cumulativeWinners: 0, idealCumulative: 0, _s: b });
  for (const o of orders) {
    if (o.mode !== m) continue;
    const created = Date.parse(o.createdAt);
    if (o.rollN != null && created >= s) {
      const i = Math.floor((created - s) / size);
      if (buckets[i]) buckets[i].eligible++;
    }
    if (o.status === 'won' || o.status === 'shadow_won') {
      const wt = Date.parse(o.trayAddedAt || o.updatedAt);
      const i = Math.floor((wt - s) / size);
      if (buckets[i]) buckets[i].winners++;
    }
  }
  let cum = 0;
  for (const b of buckets) {
    cum += b.winners;
    b.cumulativeWinners = cum;
    b.idealCumulative = round2((settings.cap * Math.min(e, b._s + size) - settings.cap * s) / (e - s));
    delete b._s;
  }
  return { bucketMinutes, window: { startsAt: settings.startsAt, endsAt: settings.endsAt }, cap: settings.cap, buckets };
}

// ---------------------------------------------------------------- http

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function send(res, code, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  const data = isStr ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': isStr ? (headers['Content-Type'] || 'text/plain; charset=utf-8') : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer',
    });
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { resolve(Symbol.for('bad')); }
    });
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function whoami(req) {
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${BEARER}`) return 'api-token';
  const tok = parseCookies(req).gt_session;
  return tok && sessions.has(tok) ? sessions.get(tok) : null;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function winnersFor(mode) {
  const st = mode === 'shadow' ? 'shadow_won' : 'won';
  return orders.filter((o) => o.status === st && o.mode === mode).sort((a, b) => a.slot - b.slot);
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (method !== 'GET' && method !== 'HEAD') {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(res, 415, { error: 'unsupported_media_type', message: 'Send Content-Type: application/json' });
    }
  }
  const body = method === 'GET' ? undefined : await readJson(req);
  if (body === Symbol.for('bad')) return send(res, 400, { error: 'invalid', field: null, message: 'Malformed JSON' });

  if (p === '/api/login' && method === 'POST') {
    const ip = req.socket.remoteAddress;
    const t = Date.now();
    const list = (loginAttempts.get(ip) || []).filter((x) => t - x < 60000);
    if (list.length >= 5) return send(res, 429, { error: 'too_many_attempts' });
    list.push(t); loginAttempts.set(ip, list);
    const name = body && typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
    if (!body || body.password !== PASSWORD) return send(res, 401, { error: 'bad_password' });
    if (!name) return send(res, 400, { error: 'invalid', field: 'name', message: 'Enter your name' });
    loginAttempts.delete(ip);
    const tok = crypto.randomBytes(24).toString('hex');
    sessions.set(tok, name);
    addEvent('info', 'login', `${name} signed in`, { actor: name });
    return send(res, 200, { ok: true, name }, { 'Set-Cookie': `gt_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
  }

  const actor = whoami(req);
  if (!actor) return send(res, 401, { error: 'unauthorized' });

  if (p === '/api/logout' && method === 'POST') {
    const tok = parseCookies(req).gt_session;
    if (tok) sessions.delete(tok);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'gt_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (p === '/api/me' && method === 'GET') return send(res, 200, { name: actor });
  if (p === '/api/status' && method === 'GET') return send(res, 200, status());

  if (p === '/api/settings' && method === 'PATCH') {
    const [code, out] = patchSettings(body, actor);
    return send(res, code, out);
  }

  if (p === '/api/orders' && method === 'GET') {
    const st = url.searchParams.get('status') || 'all';
    const mode = url.searchParams.get('mode') || '';
    const q = (url.searchParams.get('q') || '').trim().toLowerCase().replace(/^#/, '');
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    let list = orders.filter((o) =>
      (st === 'all' || o.status === st) &&
      (!mode || o.mode === mode) &&
      (!q || o.id.includes(q) || String(o.number).includes(q) || (o.customerEmail || '').toLowerCase().includes(q)));
    list = list.slice().reverse();
    return send(res, 200, { total: list.length, items: list.slice(offset, offset + limit).map(publicOrder) });
  }

  if (p === '/api/winners' && method === 'GET') {
    const mode = url.searchParams.get('mode') === 'shadow' ? 'shadow' : 'live';
    return send(res, 200, { items: winnersFor(mode).map(publicOrder) });
  }

  if (p === '/api/winners.csv' && method === 'GET') {
    const mode = url.searchParams.get('mode') === 'shadow' ? 'shadow' : 'live';
    const lines = ['slot,order,order_id,created_at,won_at,customer_id,customer_email,subtotal,tag_status'];
    for (const o of winnersFor(mode)) {
      lines.push([o.slot, o.name, o.id, o.createdAt, o.trayAddedAt || o.updatedAt, o.customerId, o.customerEmail, o.subtotal, o.tagStatus].map(csvCell).join(','));
    }
    return send(res, 200, lines.join('\n') + '\n', {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="golden-tray-winners-${mode}.csv"`,
    });
  }

  if (p === '/api/orders/check' && method === 'POST') {
    const [code, out] = checkOrder(body && body.order);
    return send(res, code, out);
  }

  let m = p.match(/^\/api\/orders\/([^/]+)\/(retry|retry-tags)$/);
  if (m && method === 'POST') {
    const o = byId.get(decodeURIComponent(m[1]));
    if (!o) return send(res, 404, { error: 'not_found', message: 'No such order' });
    if (m[2] === 'retry') {
      if (o.status !== 'failed' && o.status !== 'skipped') return send(res, 409, { error: 'not_retryable', message: `Order is ${o.status}` });
      if (o.reason === 'campaign_off' && settings.mode === 'off') return send(res, 409, { error: 'campaign_off', message: 'Turn the giveaway on first' });
      o.status = 'queued'; o.reason = null; o.lastError = null; o.slot = null; o.mode = null; o.rollN = null;
      o._processAfter = now() + 3000; o.updatedAt = iso(now());
      addEvent('info', 'retry', 'Re-queued by admin', { order: o, actor });
      return send(res, 200, { ok: true });
    }
    if (!(o.status === 'won' && o.tagStatus === 'failed')) return send(res, 409, { error: 'not_retryable', message: 'Tags are not in a failed state' });
    o.tagStatus = 'pending'; o._tagRetryAt = now() + 3000;
    addEvent('info', 'retry_tags', 'Tag retry requested', { order: o, actor });
    return send(res, 200, { ok: true });
  }

  if (p === '/api/timeline' && method === 'GET') {
    const bm = Math.min(120, Math.max(1, Number(url.searchParams.get('bucketMinutes')) || 15));
    return send(res, 200, timeline(bm));
  }

  if (p === '/api/events' && method === 'GET') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const before = url.searchParams.get('before');
    const out = [];
    for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
      if (before && !(events[i].id < Number(before))) continue;
      out.push(events[i]);
    }
    return send(res, 200, { items: out });
  }

  if (p === '/api/setup' && method === 'GET') {
    const s = runSetupChecks();
    return send(res, 200, { ok: s.ok, checkedAt: s.checkedAt, checks: s.checks, webhook: { registered: webhook.registered, uri: webhook.uri } });
  }

  if (p === '/api/setup/webhook' && method === 'POST') {
    if (webhook.registered) return send(res, 200, { ok: true, created: false, id: webhook.id });
    webhook = { registered: true, id: `gid://shopify/WebhookSubscription/${1500000000 + Math.floor(Math.random() * 1e6)}`, uri: 'https://golden-tray.example.com/webhooks/orders/create' };
    runSetupChecks();
    addEvent('info', 'webhook', 'Registered orders/create webhook', { actor });
    return send(res, 200, { ok: true, created: true, id: webhook.id });
  }

  if (p === '/api/reset' && method === 'POST') {
    if (!body || body.confirm !== 'RESET') return send(res, 400, { error: 'invalid', field: 'confirm', message: 'Type RESET to confirm' });
    if (body.scope !== 'shadow' && body.scope !== 'all') return send(res, 400, { error: 'invalid', field: 'scope', message: 'scope must be shadow or all' });
    if (body.scope === 'all' && settings.mode === 'live') return send(res, 409, { error: 'live_mode', message: 'Switch off Live before resetting all data' });
    let deleted = 0;
    for (let i = orders.length - 1; i >= 0; i--) {
      if (body.scope === 'all' || orders[i].mode === 'shadow') { byId.delete(orders[i].id); orders.splice(i, 1); deleted++; }
    }
    addEvent('warn', 'reset', `Reset ${body.scope} data: ${deleted} orders deleted`, { actor });
    return send(res, 200, { ok: true, deleted });
  }

  return send(res, 404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return send(res, 200, { ok: true });
  if (url.pathname.startsWith('/api/')) {
    // small artificial latency so busy states are visible
    setTimeout(() => handleApi(req, res, url).catch((e) => { console.error(e); send(res, 500, { error: 'internal', message: e.message }); }), 120 + Math.random() * 250);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  serveStatic(req, res, url.pathname);
});

seed();
runSetupChecks();
setInterval(simTick, 1000).unref();
server.listen(PORT, () => {
  console.log(`Golden tray mock server on http://localhost:${PORT}  (password "dev", clock ${iso(now())}, speed ${SPEED}x, mode ${settings.mode})`);
});
