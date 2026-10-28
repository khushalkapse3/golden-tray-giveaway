'use strict';

// The giveaway itself: receive orders, roll, claim a slot under the cap, add the tray, tag.
// Every Shopify and clock dependency is injected so the tests can drive it step by step.

const crypto = require('node:crypto');
const { fromWebhook, maskEmail } = require('./normalize');
const { prefilter, freshCheck } = require('./eligibility');
const { validatePatch, SettingsError, LOCKED_WHILE_LIVE } = require('./settings');
const { windowInfo, pacing, timeline } = require('./pacing');
const { AWARD_BACKOFF_SECONDS, MAX_AWARD_ATTEMPTS } = require('./rules');

const WAIT_RECHECK_SECONDS = 15;
const TAG_RETRY_SECONDS = 60;
const BACKFILL_LOOKBACK_MS = 30 * 60000;
const BACKFILL_OVERLAP_MS = 5 * 60000;
const BACKFILL_GRACE_MS = 30 * 60000;
// write_X includes read_X.
const REQUIRED_SCOPES = ['read_orders', 'write_orders', 'write_order_edits', 'read_products', 'write_customers'];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const iso = (date) => date.toISOString();
const addSeconds = (date, seconds) => new Date(date.getTime() + seconds * 1000);

class Engine {
  constructor({ store, shopify, config, clock = () => new Date(), random = (n) => crypto.randomInt(n), logger, authMode = 'token', version = '1.0.0' }) {
    this.store = store;
    this.shopify = shopify;
    this.config = config;
    this.clock = clock;
    this.random = random;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.authMode = authMode;
    this.version = version;
    this.inflight = new Map(); // order id -> promise
    this.tagInflight = new Set();
    this.worker = { running: false, lastTickAt: null };
  }

  /** What the engine works with: the dashboard settings plus the fixed rules (never editable). */
  settings() {
    const { delaySeconds, maxWaitSeconds, routedTags, releasedTags } = this.config.rules;
    return { ...this.store.getSettings(), delaySeconds, maxWaitSeconds, routedTags, releasedTags };
  }

  event(fields) {
    this.store.addEvent({ at: iso(this.clock()), ...fields });
    const log = fields.level === 'error' ? this.logger.error : fields.level === 'warn' ? this.logger.warn : this.logger.info;
    log(fields.message || fields.type, { type: fields.type, orderId: fields.orderId, orderName: fields.orderName, actor: fields.actor });
  }

  // --- receiving --------------------------------------------------------------------------

  receiveWebhook(payload) {
    return this.receiveOrder(fromWebhook(payload), 'webhook');
  }

  receiveOrder(order, source) {
    const settings = this.settings();
    if (settings.mode === 'off') return { stored: false, reason: 'campaign_off' };
    if (!order?.id) return { stored: false, reason: 'no_order_id' };
    const check = prefilter(order, settings);
    // Bundle orders outside the window (the bundle sells for weeks) and other orders are noise.
    if (!check.inWindow) return { stored: false, reason: 'outside_window' };
    if (!check.hasQualifyingSku) return { stored: false, reason: 'no_qualifying_sku' };

    const now = this.clock();
    const status = check.ok ? 'queued' : 'not_eligible';
    const runAt = new Date(Math.max(now.getTime(), new Date(order.createdAt).getTime() + settings.delaySeconds * 1000));
    const processAfter = source === 'webhook' ? addSeconds(now, settings.delaySeconds) : runAt;
    const inserted = this.store.insertOrder({
      id: order.id, gid: order.gid, name: order.name, number: order.number,
      created_at: order.createdAt, received_at: iso(now), source,
      subtotal: order.subtotal, currency: order.currency,
      customer_id: order.customerId, customer_gid: order.customerGid, customer_email: maskEmail(order.email), country: order.country,
      status, reason: check.reason, mode: settings.mode,
      process_after: check.ok ? iso(processAfter) : null,
      decided_at: check.ok ? null : iso(now),
    });
    if (!inserted) return { stored: false, status: this.store.getOrder(order.id).status, reason: 'duplicate' };
    return { stored: true, status, reason: check.reason };
  }

  // --- worker -----------------------------------------------------------------------------

  /**
   * Starts due work (awards up to the concurrency limit, tag retries). Returns how many items it
   * started. With wait=true (tests) it resolves when they are done; the job loop passes false.
   */
  async tick({ wait = true } = {}) {
    const now = this.clock();
    this.worker.lastTickAt = iso(now);
    const free = Math.max((this.config.worker?.concurrency || 2) - this.inflight.size, 0);
    const due = free > 0 ? this.store.dueOrders(iso(now), free, new Set(this.inflight.keys())) : [];
    const started = due.map((row) => {
      const task = this.processOne(row)
        .catch((error) => this.logger.error('processOne crashed', { orderId: row.id, error: error.message }))
        .finally(() => this.inflight.delete(row.id));
      this.inflight.set(row.id, task);
      return task;
    });
    const tagRows = this.store.tagRetriesDue(iso(now)).filter((r) => !this.tagInflight.has(r.id));
    const tagTasks = tagRows.map((row) => {
      this.tagInflight.add(row.id);
      return this.tagWinner(row, { retry: true }).finally(() => this.tagInflight.delete(row.id));
    });
    if (wait) await Promise.all([...started, ...tagTasks]);
    return started.length + tagTasks.length;
  }

  /** Resolves when every award in flight has finished (graceful shutdown). */
  async idle() {
    await Promise.all([...this.inflight.values()]);
  }

  recover() {
    return this.store.recoverAwarding(iso(this.clock()));
  }

  async processOne(row) {
    const settings = this.settings();
    const now = this.clock();
    const id = row.id;

    if (settings.mode === 'off') {
      this.store.updateOrder(id, { status: 'skipped', reason: 'campaign_off', decided_at: iso(now) });
      return;
    }
    const mode = settings.mode;

    if (!row.roll_won) {
      if (this.store.winnerCount(mode, { includeAwarding: true }) >= settings.cap) return this.capReached(row, mode, settings);
      const won = this.random(settings.oneInN) === 0;
      this.store.updateOrder(id, { rolled: 1, roll_n: settings.oneInN, mode, roll_won: won ? 1 : 0 });
      if (!won) {
        this.store.updateOrder(id, { status: 'lost', decided_at: iso(now) });
        return;
      }
    }

    if (mode === 'shadow') {
      if (this.store.winnerCount('shadow') >= settings.cap) return this.capReached(row, mode, settings);
      const slot = this.store.markWon(id, 'shadow', iso(now));
      this.event({ type: 'shadow_won', orderId: id, orderName: row.name, message: `Shadow winner ${slot} of ${settings.cap} (no tray added)` });
      return;
    }

    if (!this.store.claim(id, settings.cap)) return this.capReached(row, mode, settings);
    try {
      await this.award(this.store.getOrder(id), settings);
    } catch (error) {
      this.failure(this.store.getOrder(id), { step: 'read', retryable: error.retryable !== false, error: error.message });
    }
  }

  capReached(row, mode, settings) {
    this.store.updateOrder(row.id, { status: 'cap_reached', mode, rolled: 1, decided_at: iso(this.clock()) });
    const flag = `cap_event_${mode}`;
    if (!this.store.kvGet(flag)) {
      this.store.kvSet(flag, true);
      this.event({ type: 'cap_reached', level: 'warn', orderId: row.id, orderName: row.name, message: `Cap of ${settings.cap} reached (${mode}): no more trays` });
    }
  }

  async award(row, settings) {
    const now = this.clock();
    const order = await this.shopify.getOrder(row.id);
    const verdict = freshCheck(order, settings, { now, waitStartedAt: row.wait_started_at, commitAttempted: Boolean(row.commit_attempted) });

    if (verdict.action === 'skip') {
      this.store.updateOrder(row.id, { status: 'skipped', reason: verdict.reason, decided_at: iso(now) });
      this.event({ type: 'skipped', orderId: row.id, orderName: row.name, message: `Won the roll but skipped: ${verdict.reason}` });
      return;
    }
    if (verdict.action === 'wait') {
      this.store.updateOrder(row.id, {
        status: 'queued',
        process_after: iso(addSeconds(now, WAIT_RECHECK_SECONDS)),
        wait_started_at: row.wait_started_at || iso(now),
        last_step: `waiting:${verdict.reason}`,
      });
      return;
    }
    if (verdict.action === 'already_present') return this.won(row, settings, { alreadyPresent: true });
    if (verdict.reason === 'routing_wait_timeout') {
      this.event({ type: 'routing_wait_timeout', level: 'warn', orderId: row.id, orderName: row.name, message: `No linc-app routing tag after ${settings.maxWaitSeconds}s: adding the tray anyway` });
    }

    const result = await this.shopify.addFreeTray({
      orderGid: row.gid || `gid://shopify/Order/${row.id}`,
      variantId: settings.trayVariantId,
      traySku: settings.traySku,
      discountDescription: settings.discountDescription,
      staffNote: `Golden tray giveaway (${settings.campaignName}): free ${settings.traySku} added at £0 by the golden tray app. No customer email sent.`,
      beforeCommit: () => { this.store.updateOrder(row.id, { commit_attempted: 1, last_step: 'commit' }); },
    });
    if (result.ok) return this.won(row, settings, { alreadyPresent: result.alreadyPresent });
    return this.failure(this.store.getOrder(row.id), result);
  }

  async won(row, settings, { alreadyPresent = false } = {}) {
    const slot = this.store.markWon(row.id, 'live', iso(this.clock()));
    this.event({
      type: 'won', orderId: row.id, orderName: row.name,
      message: `Winner ${slot} of ${settings.cap}: tray ${alreadyPresent ? 'was already on the order' : 'added at £0'}`,
    });
    await this.tagWinner(this.store.getOrder(row.id));
  }

  failure(row, { step, retryable, error }) {
    const now = this.clock();
    const attempts = (row.attempts || 0) + 1;
    const lastError = `${step}: ${error}`;
    if (retryable && attempts < MAX_AWARD_ATTEMPTS) {
      const wait = AWARD_BACKOFF_SECONDS[attempts - 1];
      this.store.updateOrder(row.id, { status: 'queued', attempts, last_error: lastError, last_step: step, process_after: iso(addSeconds(now, wait)) });
      this.event({ type: 'award_retry', level: 'warn', orderId: row.id, orderName: row.name, message: `Attempt ${attempts} failed (${lastError}); retrying in ${wait}s` });
      return;
    }
    this.store.updateOrder(row.id, { status: 'failed', reason: step, attempts, last_error: lastError, last_step: step, decided_at: iso(now) });
    this.event({ type: 'award_failed', level: 'error', orderId: row.id, orderName: row.name, message: `Tray not added after ${attempts} attempt(s): ${lastError}` });
  }

  async tagWinner(row, { retry = false } = {}) {
    const settings = this.settings();
    try {
      await this.shopify.addTags(row.gid || `gid://shopify/Order/${row.id}`, [settings.tag]);
      if (row.customer_gid) await this.shopify.addTags(row.customer_gid, [settings.tag]);
      this.store.updateOrder(row.id, { tag_status: 'ok', tag_next_at: null });
      if (retry) this.event({ type: 'tags_added', orderId: row.id, orderName: row.name, message: `Tagged ${settings.tag} on retry` });
    } catch (error) {
      const attempts = (row.tag_attempts || 0) + 1;
      this.store.updateOrder(row.id, { tag_status: 'failed', tag_attempts: attempts, tag_next_at: iso(addSeconds(this.clock(), TAG_RETRY_SECONDS)), last_error: `tags: ${error.message}` });
      this.event({ type: 'tag_failed', level: 'warn', orderId: row.id, orderName: row.name, message: `Tagging failed (attempt ${attempts}): ${error.message}` });
    }
  }

  // --- admin actions ----------------------------------------------------------------------

  async updateSettings(patch, actor) {
    const current = this.store.getSettings();
    const { next, changed, warnings } = validatePatch(patch, current, { winners: this.store.winnerCount('live'), now: this.clock() });
    if (next.mode === 'live' && current.mode !== 'live') {
      const setup = await this.setupCheck(next);
      if (!setup.ok) {
        throw new SettingsError('mode', 'The setup check failed, so the giveaway can not go live', { status: 409, code: 'setup_incomplete', problems: setup.problems });
      }
    }
    if (changed.length > 0) this.store.saveSettings(next, { actor, changed, previous: current });
    return { settings: next, warnings, changed };
  }

  async retryOrder(id, actor) {
    const row = this.store.getOrder(id);
    if (!row) throw new HttpError(404, 'not_found', 'Order not found');
    if (!['failed', 'skipped'].includes(row.status)) throw new HttpError(409, 'not_retryable', `Only failed or skipped orders can be retried (this one is ${row.status})`);
    this.store.updateOrder(id, { status: 'queued', reason: null, attempts: 0, process_after: iso(this.clock()), wait_started_at: null, last_error: null });
    this.event({ type: 'manual_retry', actor, orderId: id, orderName: row.name, message: `Re-queued by ${actor}` });
    return { ok: true };
  }

  async retryOrderTags(id, actor) {
    const row = this.store.getOrder(id);
    if (!row) throw new HttpError(404, 'not_found', 'Order not found');
    if (row.status !== 'won') throw new HttpError(409, 'not_a_winner', 'Only live winners are tagged');
    this.store.updateOrder(id, { tag_attempts: 0 });
    this.event({ type: 'manual_retry_tags', actor, orderId: id, orderName: row.name, message: `Tag retry by ${actor}` });
    await this.tagWinner(this.store.getOrder(id), { retry: true });
    return { ok: true, tagStatus: this.store.getOrder(id).tag_status };
  }

  async reset(scope, confirm, actor) {
    if (!['shadow', 'all'].includes(scope)) throw new HttpError(400, 'invalid', 'scope must be shadow or all');
    if (confirm !== 'RESET') throw new HttpError(400, 'confirm_required', 'Type RESET to confirm');
    if (scope === 'all' && this.settings().mode === 'live') throw new HttpError(409, 'live', 'Switch the giveaway off (or to shadow) before deleting all orders');
    const deleted = this.store.reset(scope);
    this.store.kvSet('cap_event_shadow', false);
    if (scope === 'all') this.store.kvSet('cap_event_live', false);
    this.event({ type: 'reset', level: 'warn', actor, message: `${actor} deleted ${deleted} ${scope === 'shadow' ? 'shadow ' : ''}order row(s)` });
    return { ok: true, deleted };
  }

  async checkOrder(ref) {
    const order = await this.shopify.findOrder(ref);
    if (!order) throw new HttpError(404, 'not_found', `No order ${ref} in Shopify`);
    const settings = this.settings();
    const stored = this.store.getOrder(order.id) || null;
    const pre = prefilter(order, settings);
    const fresh = freshCheck(order, settings, { now: this.clock(), waitStartedAt: stored?.wait_started_at, commitAttempted: Boolean(stored?.commit_attempted) });
    const checks = [...pre.checks, ...fresh.checks.filter((c) => !pre.checks.some((p) => p.name === c.name))];
    return {
      order: { id: order.id, name: order.name, createdAt: order.createdAt, subtotal: order.subtotal, currency: order.currency, tags: order.tags, financialStatus: order.financialStatus },
      checks,
      eligible: pre.ok && fresh.action !== 'skip',
      verdict: pre.ok ? fresh.action : 'not_eligible',
      reason: pre.reason || fresh.reason,
      stored: stored ? this.toApiOrder(stored) : null,
    };
  }

  // --- setup ------------------------------------------------------------------------------

  webhookUri() {
    return this.config.publicUrl ? `${this.config.publicUrl}/webhooks/orders/create` : null;
  }

  async setupCheck(settings = this.settings()) {
    const checks = [];
    const add = (name, ok, detail, blocking = true) => checks.push({ name, ok, detail, blocking });
    add('tray_settings', Boolean(settings.traySku && settings.trayVariantId), settings.traySku && settings.trayVariantId ? `tray ${settings.traySku} / variant ${settings.trayVariantId}` : 'Tray SKU and variant id must be set');
    add('qualifying_skus', settings.qualifyingSkus.length > 0, `qualifying: ${settings.qualifyingSkus.join(', ')}`);

    const safely = async (name, fn) => {
      try { await fn(); } catch (error) { add(name, false, `${name}: ${error.message}`); }
    };
    await safely('shop', async () => {
      const shop = await this.shopify.getShop();
      add('shop', shop.myshopifyDomain === this.config.shopify.domain, `connected to ${shop.myshopifyDomain} (${shop.name})`);
    });
    await safely('scopes', async () => {
      const scopes = new Set(await this.shopify.getAccessScopes());
      const has = (scope) => scopes.has(scope) || (scope.startsWith('read_') && scopes.has(scope.replace('read_', 'write_')));
      const missing = REQUIRED_SCOPES.filter((s) => !has(s));
      add('scopes', missing.length === 0, missing.length ? `Missing access scopes: ${missing.join(', ')}` : 'All required access scopes granted');
    });
    if (settings.trayVariantId) {
      await safely('tray_variant', async () => {
        const v = await this.shopify.getVariant(settings.trayVariantId);
        if (!v) return add('tray_variant', false, `Tray variant ${settings.trayVariantId} not found in Shopify`);
        add('tray_sku_matches', String(v.sku || '').toLowerCase() === String(settings.traySku).toLowerCase(), `variant SKU is ${v.sku}, settings say ${settings.traySku}`);
        add('tray_active', v.productStatus === 'ACTIVE', `"${v.productTitle}" is ${v.productStatus}, price ${v.price}`);
      });
    }
    const webhook = { registered: false, uri: this.webhookUri() };
    if (!webhook.uri) {
      // The app can only list webhooks that it registered itself through the API. A webhook set up
      // by hand in the Shopify admin is invisible to it, so there is nothing to verify here.
      add('webhook', true, 'Order webhooks are not checked by the app (PUBLIC_URL is not set). If the webhook is set in the Shopify admin it works; the backfill finds any order it misses.', false);
    } else {
      await safely('webhook', async () => {
        const subs = await this.shopify.listWebhooks();
        webhook.registered = subs.some((s) => s.uri === webhook.uri);
        add('webhook', webhook.registered, webhook.registered ? `orders/create → ${webhook.uri}` : `No orders/create webhook to ${webhook.uri} (the backfill still finds orders)`, false);
      });
    }
    const problems = checks.filter((c) => c.blocking && !c.ok).map((c) => c.detail);
    const result = { ok: problems.length === 0, checkedAt: iso(this.clock()), checks, problems, webhook };
    this.store.kvSet('setup', { ok: result.ok, checkedAt: result.checkedAt, problems });
    return result;
  }

  async registerWebhook(actor) {
    const uri = this.webhookUri();
    if (!uri) throw new HttpError(409, 'no_public_url', 'Set PUBLIC_URL first');
    const existing = (await this.shopify.listWebhooks()).find((s) => s.uri === uri);
    if (existing) return { ok: true, created: false, id: existing.id };
    const created = await this.shopify.createWebhook(uri);
    this.event({ type: 'webhook_registered', actor, message: `orders/create webhook registered to ${uri}` });
    return { ok: true, created: true, id: created.id };
  }

  // --- background jobs --------------------------------------------------------------------

  async backfillTick() {
    const settings = this.settings();
    const now = this.clock();
    const start = new Date(settings.startsAt).getTime();
    const end = new Date(settings.endsAt).getTime();
    const state = this.store.kvGet('backfill') || {};
    if (settings.mode === 'off' || now.getTime() < start || now.getTime() > end + BACKFILL_GRACE_MS) {
      return { ran: false, found: 0 };
    }
    const sinceMs = Math.max(start, state.lastRunAt ? new Date(state.lastRunAt).getTime() - BACKFILL_OVERLAP_MS : now.getTime() - BACKFILL_LOOKBACK_MS);
    const since = iso(new Date(sinceMs));
    const until = iso(new Date(Math.min(end, now.getTime())));
    try {
      const orders = await this.shopify.recentOrders({ since, until });
      let found = 0;
      for (const order of orders) {
        if (this.store.getOrder(order.id)) continue;
        if (this.receiveOrder(order, 'backfill').stored) found += 1;
      }
      this.store.kvSet('backfill', { lastRunAt: iso(now), lastFound: found, lastError: null });
      if (found > 0) this.event({ type: 'backfill_found', level: 'warn', message: `Backfill found ${found} order(s) the webhook missed` });
      return { ran: true, found };
    } catch (error) {
      this.store.kvSet('backfill', { ...state, lastError: error.message, lastErrorAt: iso(now) });
      this.logger.warn('backfill failed', { error: error.message });
      return { ran: true, found: 0, error: error.message };
    }
  }

  // --- read models for the API ------------------------------------------------------------

  pacedMode(settings) {
    return settings.mode === 'shadow' ? 'shadow' : 'live';
  }

  pacingNow(settings = this.store.getSettings(), now = this.clock()) {
    return pacing(settings, { candidates: this.store.candidateCount(settings), winners: this.store.winnerCount(this.pacedMode(settings)), now });
  }

  adminOrdersUrl() {
    return `https://admin.shopify.com/store/${this.config.shopify.adminStoreHandle}/orders/`;
  }

  toApiOrder(row) {
    return {
      id: row.id, name: row.name, number: row.number, createdAt: row.created_at, receivedAt: row.received_at,
      source: row.source, subtotal: row.subtotal, currency: row.currency,
      customerId: row.customer_id, customerEmail: row.customer_email, country: row.country,
      status: row.status, reason: row.reason, mode: row.mode, slot: row.slot, rollN: row.roll_n,
      attempts: row.attempts, lastError: row.last_error, lastStep: row.last_step, trayAddedAt: row.tray_added_at,
      tagStatus: row.tag_status, updatedAt: row.updated_at,
      adminUrl: `${this.adminOrdersUrl()}${row.id}`,
    };
  }

  status() {
    const settings = this.store.getSettings();
    const now = this.clock();
    const counts = this.store.counts();
    const mode = this.pacedMode(settings);
    const p = this.pacingNow(settings, now);
    const backfill = this.store.kvGet('backfill') || {};
    const { delaySeconds, maxWaitSeconds, routedTags, releasedTags } = this.config.rules;
    return {
      now: iso(now),
      version: this.version,
      settings,
      rules: { delaySeconds, maxWaitSeconds, routedTags, releasedTags },
      lockedWhileLive: LOCKED_WHILE_LIVE,
      window: windowInfo(settings, now),
      counts,
      activeMode: settings.mode === 'off' ? null : settings.mode,
      traysLeft: Math.max(settings.cap - this.store.winnerCount(mode), 0),
      pacing: p,
      worker: {
        running: this.worker.running,
        lastTickAt: this.worker.lastTickAt,
        queued: counts.live.queued + counts.shadow.queued,
        awarding: counts.live.awarding,
        tagRetriesPending: this.store.tagRetriesDue('9999').length,
      },
      backfill: { lastRunAt: backfill.lastRunAt || null, lastFound: backfill.lastFound ?? 0, lastError: backfill.lastError || null },
      shopify: { store: this.config.shopify.domain, adminOrdersUrl: this.adminOrdersUrl(), apiVersion: this.config.shopify.apiVersion, authMode: this.authMode },
      setup: this.store.kvGet('setup') || { ok: false, checkedAt: null, problems: ['Setup check has not run yet'] },
    };
  }

  timeline(bucketMinutes) {
    const settings = this.settings();
    const minutes = Math.min(Math.max(parseInt(bucketMinutes, 10) || 15, 1), 240);
    return timeline(settings, this.store.timelineRows(this.pacedMode(settings)), { bucketMinutes: minutes, now: this.clock() });
  }
}

module.exports = { Engine, HttpError, REQUIRED_SCOPES };
