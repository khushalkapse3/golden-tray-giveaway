'use strict';

// Storage on libSQL: a hosted Turso database in production (DATABASE_URL=libsql://..., free plan),
// a plain file or memory for local work and tests (file:./data/golden-tray.db, :memory:). Same SQL
// dialect as SQLite, so one code path serves all of them.
//
// Atomicity without transactions: SQLite runs one statement at a time, so the two steps that must
// never race (taking a slot under the cap, handing out the next slot number) are each ONE statement.
// An in-process lock also serialises them, because this app runs as a single instance.
//
// Free-plan read budget (500 M rows/month): the heavy dashboard reads (counts, timeline, lists) scan
// the orders table, so they are cached for `cacheMs` (the server uses 8 s). Everything the giveaway
// decides on (winner count, claim, due orders) is never cached.

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { DEFAULTS, seedDefaults } = require('./settings');

const STATUSES = ['queued', 'not_eligible', 'lost', 'cap_reached', 'awarding', 'won', 'shadow_won', 'skipped', 'failed'];
const ORDER_COLUMNS = [
  'id', 'gid', 'name', 'number', 'created_at', 'received_at', 'source', 'subtotal', 'currency',
  'customer_id', 'customer_gid', 'customer_email', 'country', 'status', 'reason', 'mode', 'slot',
  'roll_n', 'rolled', 'roll_won', 'attempts', 'process_after', 'wait_started_at', 'last_error',
  'last_step', 'commit_attempted', 'tray_added_at', 'tag_status', 'tag_attempts', 'tag_next_at',
  'decided_at', 'updated_at',
];
const TAG_RETRY_LIMIT = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  gid TEXT, name TEXT, number INTEGER, created_at TEXT, received_at TEXT NOT NULL, source TEXT,
  subtotal REAL, currency TEXT, customer_id TEXT, customer_gid TEXT, customer_email TEXT, country TEXT,
  status TEXT NOT NULL, reason TEXT, mode TEXT, slot INTEGER, roll_n INTEGER,
  rolled INTEGER NOT NULL DEFAULT 0, roll_won INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  process_after TEXT, wait_started_at TEXT, last_error TEXT, last_step TEXT,
  commit_attempted INTEGER NOT NULL DEFAULT 0, tray_added_at TEXT,
  tag_status TEXT, tag_attempts INTEGER NOT NULL DEFAULT 0, tag_next_at TEXT,
  decided_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_due ON orders (status, process_after);
CREATE INDEX IF NOT EXISTS orders_mode_status ON orders (mode, status);
CREATE INDEX IF NOT EXISTS orders_created ON orders (created_at);
CREATE INDEX IF NOT EXISTS orders_tags ON orders (status, tag_status, tag_next_at);
CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, level TEXT NOT NULL, type TEXT NOT NULL,
  order_id TEXT, order_name TEXT, actor TEXT, message TEXT, data TEXT
);
`;

const nowIso = () => new Date().toISOString();
const show = (value) => (Array.isArray(value) ? value.join(', ') : String(value));
const clone = (value) => structuredClone(value);

/** One libSQL result row as a plain object keyed by column name. */
const rowObject = (columns, row) => Object.fromEntries(columns.map((name, i) => [name, row[i]]));
const rowsOf = (result) => result.rows.map((row) => rowObject(result.columns, row));

class Store {
  constructor(client, { cacheMs = 0 } = {}) {
    this.client = client;
    this.cacheMs = cacheMs;
    this.settingsCache = null;
    this.readCache = new Map(); // key -> {at, value}
    this.chain = Promise.resolve();
  }

  /**
   * url: libsql://... (Turso), file:path or :memory:. authToken is only for Turso.
   * seed: first-boot tray SKU / variant. cacheMs: how long the heavy dashboard reads are reused.
   */
  static async open(url, { authToken, seed = {}, cacheMs = 0 } = {}) {
    const target = String(url || '').trim();
    if (!target) throw new Error('DATABASE_URL is required (libsql://... for Turso, or file:./data/golden-tray.db for a local file)');
    if (!/^(libsql|https?|wss?|file):/.test(target) && target !== ':memory:') {
      throw new Error(`DATABASE_URL must start with libsql:// (Turso), file: or be :memory: (got "${target.split(':')[0]}:")`);
    }
    if (target.startsWith('file:')) fs.mkdirSync(path.dirname(target.slice('file:'.length)), { recursive: true });
    const client = createClient({ url: target, authToken: authToken || undefined });
    const store = new Store(client, { cacheMs });
    if (target.startsWith('file:') || target === ':memory:') await client.execute('PRAGMA busy_timeout = 5000');
    await client.executeMultiple(SCHEMA);
    const { rows } = await client.execute('SELECT COUNT(*) AS n FROM settings');
    if (Number(rows[0][0]) === 0) await store.writeSettings(seedDefaults(seed));
    return store;
  }

  async close() {
    this.client.close();
  }

  /** Runs fn after every earlier exclusive call has finished (one at a time, in order). */
  exclusive(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Drops everything remembered in memory (settings and cached reads). */
  invalidate() {
    this.settingsCache = null;
    this.readCache.clear();
  }

  async cached(key, fn) {
    if (!(this.cacheMs > 0)) return fn();
    const hit = this.readCache.get(key);
    if (hit && Date.now() - hit.at < this.cacheMs) return clone(hit.value);
    const value = await fn();
    this.readCache.set(key, { at: Date.now(), value: clone(value) });
    return value;
  }

  async all(sql, args = []) {
    return rowsOf(await this.client.execute({ sql, args }));
  }

  async one(sql, args = []) {
    return (await this.all(sql, args))[0];
  }

  // --- settings ---------------------------------------------------------------------------

  async getSettings() {
    if (!this.settingsCache) {
      const settings = { ...DEFAULTS };
      for (const { key, value } of await this.all('SELECT key, value FROM settings')) {
        if (key in DEFAULTS) settings[key] = JSON.parse(value);
      }
      this.settingsCache = settings;
    }
    return clone(this.settingsCache);
  }

  async writeSettings(settings) {
    const sql = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
    await this.client.batch(Object.keys(DEFAULTS).map((key) => ({ sql, args: [key, JSON.stringify(settings[key])] })), 'write');
    this.settingsCache = null;
  }

  async saveSettings(next, { actor = 'system', changed = [], previous } = {}) {
    const before = previous || await this.getSettings();
    await this.writeSettings(next);
    this.readCache.clear();
    if (changed.length > 0) {
      await this.addEvent({
        type: 'settings_changed',
        actor,
        message: changed.map((key) => `${key}: ${show(before[key])} → ${show(next[key])}`).join('; '),
        data: { changed, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, next[k]])) },
      });
    }
    return next;
  }

  async kvGet(key) {
    const row = await this.one('SELECT value FROM kv WHERE key = ?', [key]);
    return row ? JSON.parse(row.value) : null;
  }

  async kvSet(key, value) {
    await this.client.execute({ sql: 'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: [key, JSON.stringify(value)] });
  }

  // --- orders -----------------------------------------------------------------------------

  /** Returns false when the order is already stored (duplicate webhook or backfill). */
  async insertOrder(fields) {
    const data = { attempts: 0, rolled: 0, roll_won: 0, commit_attempted: 0, tag_attempts: 0, updated_at: nowIso(), ...fields };
    const columns = ORDER_COLUMNS.filter((c) => data[c] !== undefined);
    const result = await this.client.execute({
      sql: `INSERT OR IGNORE INTO orders (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      args: columns.map((c) => data[c]),
    });
    return result.rowsAffected === 1;
  }

  async getOrder(id) {
    return this.one('SELECT * FROM orders WHERE id = ?', [String(id)]);
  }

  async updateOrder(id, fields) {
    const data = { ...fields, updated_at: nowIso() };
    const columns = Object.keys(data).filter((c) => ORDER_COLUMNS.includes(c) && c !== 'id');
    const result = await this.client.execute({
      sql: `UPDATE orders SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      args: [...columns.map((c) => (data[c] === undefined ? null : data[c])), String(id)],
    });
    return result.rowsAffected === 1;
  }

  async dueOrders(now, limit, exclude = new Set()) {
    const rows = await this.all("SELECT * FROM orders WHERE status = 'queued' AND process_after <= ? ORDER BY process_after, rowid LIMIT ?", [now, limit + exclude.size]);
    return rows.filter((r) => !exclude.has(r.id)).slice(0, limit);
  }

  async winnerCount(mode, { includeAwarding = false } = {}) {
    if (mode === 'shadow') {
      return Number((await this.one("SELECT COUNT(*) AS n FROM orders WHERE mode = 'shadow' AND status = 'shadow_won'")).n);
    }
    const statuses = includeAwarding ? "('won', 'awarding')" : "('won')";
    return Number((await this.one(`SELECT COUNT(*) AS n FROM orders WHERE mode = 'live' AND status IN ${statuses}`)).n);
  }

  /**
   * Takes a live slot for a queued order if won + in-progress awards are below the cap.
   * One statement: the count and the update can not be separated by another request.
   */
  claim(id, cap) {
    return this.exclusive(async () => {
      const result = await this.client.execute({
        sql: `UPDATE orders SET status = 'awarding', mode = 'live', updated_at = ?
              WHERE id = ? AND status = 'queued'
                AND (SELECT COUNT(*) FROM orders WHERE mode = 'live' AND status IN ('won', 'awarding')) < ?`,
        args: [nowIso(), String(id), Number(cap)],
      });
      return result.rowsAffected === 1;
    });
  }

  /** Marks the order won with the next slot number for its mode (one statement); returns the slot. */
  markWon(id, mode, at) {
    return this.exclusive(async () => {
      const status = mode === 'shadow' ? 'shadow_won' : 'won';
      const tagNext = new Date(new Date(at).getTime() + 120000).toISOString();
      await this.client.execute({
        sql: `UPDATE orders SET status = ?, mode = ?,
                slot = (SELECT COALESCE(MAX(slot), 0) + 1 FROM orders WHERE mode = ? AND status = ?),
                tray_added_at = ?, decided_at = ?, last_error = NULL,
                tag_status = ?, tag_next_at = ?, updated_at = ?
              WHERE id = ?`,
        args: [status, mode, mode, status, at, at, mode === 'live' ? 'pending' : null, mode === 'live' ? tagNext : null, nowIso(), String(id)],
      });
      return Number((await this.one('SELECT slot FROM orders WHERE id = ?', [String(id)])).slot);
    });
  }

  /**
   * Shadow mode's version of claim + markWon in ONE statement: takes the next shadow slot for a queued
   * order only while fewer than `cap` shadow winners exist. Returns the slot, or null when full.
   */
  winShadow(id, cap, at) {
    return this.exclusive(async () => {
      const result = await this.client.execute({
        sql: `UPDATE orders SET status = 'shadow_won', mode = 'shadow',
                slot = (SELECT COALESCE(MAX(slot), 0) + 1 FROM orders WHERE mode = 'shadow' AND status = 'shadow_won'),
                tray_added_at = ?, decided_at = ?, last_error = NULL, tag_status = NULL, tag_next_at = NULL, updated_at = ?
              WHERE id = ? AND status = 'queued'
                AND (SELECT COUNT(*) FROM orders WHERE mode = 'shadow' AND status = 'shadow_won') < ?`,
        args: [at, at, nowIso(), String(id), Number(cap)],
      });
      if (result.rowsAffected !== 1) return null;
      return Number((await this.one('SELECT slot FROM orders WHERE id = ?', [String(id)])).slot);
    });
  }

  counts() {
    return this.cached('counts', async () => {
      // shadow_won is reported as "won" under the shadow mode (API counts have one "won" key).
      const empty = () => ({ received: 0, eligible: 0, tag_failed: 0, ...Object.fromEntries(STATUSES.filter((s) => s !== 'shadow_won').map((s) => [s, 0])) });
      const counts = { live: empty(), shadow: empty() };
      const rows = await this.all(`
        SELECT mode, status, COUNT(*) AS n, SUM(rolled) AS rolled, SUM(tag_status = 'failed') AS tag_failed
        FROM orders WHERE mode IN ('live', 'shadow') GROUP BY mode, status`);
      for (const r of rows) {
        const c = counts[r.mode];
        const key = r.status === 'shadow_won' ? 'won' : r.status;
        if (key in c) c[key] += Number(r.n);
        c.received += Number(r.n);
        c.eligible += Number(r.rolled || 0);
        c.tag_failed += Number(r.tag_failed || 0);
      }
      return counts;
    });
  }

  /** Qualifying orders seen in the window (any mode, any outcome but not_eligible). */
  candidateCount(settings) {
    const from = new Date(settings.startsAt).toISOString();
    const to = new Date(settings.endsAt).toISOString();
    return this.cached(`candidates:${from}:${to}`, async () => Number((await this.one(
      "SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ? AND status != 'not_eligible'", [from, to])).n));
  }

  listOrders({ status, mode, q, limit = 50, offset = 0 } = {}) {
    return this.cached(`list:${JSON.stringify([status, mode, q, limit, offset])}`, async () => {
      const where = [];
      const params = [];
      if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
      if (mode && mode !== 'all') { where.push('mode = ?'); params.push(mode); }
      if (q) {
        const like = `%${String(q).trim()}%`;
        where.push('(name LIKE ? OR CAST(number AS TEXT) = ? OR id = ? OR customer_email LIKE ?)');
        params.push(like, String(q).trim().replace(/^#/, ''), String(q).trim(), like);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = Number((await this.one(`SELECT COUNT(*) AS n FROM orders ${clause}`, params)).n);
      const items = await this.all(`SELECT * FROM orders ${clause} ORDER BY received_at DESC, rowid DESC LIMIT ? OFFSET ?`,
        [...params, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500), Math.max(parseInt(offset, 10) || 0, 0)]);
      return { total, items };
    });
  }

  winners(mode) {
    const status = mode === 'shadow' ? 'shadow_won' : 'won';
    const m = mode === 'shadow' ? 'shadow' : 'live';
    return this.cached(`winners:${m}`, () => this.all('SELECT * FROM orders WHERE mode = ? AND status = ? ORDER BY slot', [m, status]));
  }

  timelineRows(mode) {
    return this.cached(`timeline:${mode}`, () => this.all('SELECT created_at, status, tray_added_at FROM orders WHERE mode = ?', [mode]));
  }

  tagRetriesDue(now) {
    return this.all(`SELECT * FROM orders WHERE status = 'won' AND tag_status IN ('failed', 'pending')
      AND tag_attempts < ? AND tag_next_at <= ? ORDER BY tag_next_at`, [TAG_RETRY_LIMIT, now]);
  }

  /** After a crash: awards that were in progress go back to the queue (the slot is free again). */
  async recoverAwarding(now) {
    const result = await this.client.execute({ sql: "UPDATE orders SET status = 'queued', process_after = ?, updated_at = ? WHERE status = 'awarding'", args: [now, now] });
    return result.rowsAffected;
  }

  async reset(scope) {
    const sql = scope === 'shadow' ? "DELETE FROM orders WHERE mode = 'shadow'" : 'DELETE FROM orders';
    const result = await this.client.execute(sql);
    this.readCache.clear();
    return result.rowsAffected;
  }

  // --- leader lease -----------------------------------------------------------------------

  /**
   * Takes (or renews) the named lease for `holder` for ttlMs. Refused while another holder's lease is
   * still valid. One statement, so two copies of the app racing for it can not both win.
   * nowMs is injectable for tests.
   */
  async acquireLease(name, holder, ttlMs, nowMs = Date.now()) {
    const result = await this.client.execute({
      sql: `INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
            WHERE leases.holder = excluded.holder OR leases.expires_at < ?`,
      args: [name, holder, nowMs + ttlMs, nowMs],
    });
    return result.rowsAffected === 1;
  }

  /** Gives the lease up at once (clean shutdown), if `holder` still holds it. */
  async releaseLease(name, holder) {
    const result = await this.client.execute({ sql: 'DELETE FROM leases WHERE name = ? AND holder = ?', args: [name, holder] });
    return result.rowsAffected === 1;
  }

  // --- events -----------------------------------------------------------------------------

  async addEvent({ level = 'info', type, orderId = null, orderName = null, actor = null, message = '', data = null, at = nowIso() }) {
    await this.client.execute({
      sql: 'INSERT INTO events (at, level, type, order_id, order_name, actor, message, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [at, level, type, orderId === null ? null : String(orderId), orderName, actor, message, data ? JSON.stringify(data) : null],
    });
  }

  async listEvents({ limit = 50, before } = {}) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const rows = before
      ? await this.all('SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?', [Number(before), n])
      : await this.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', [n]);
    return rows.map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
  }
}

module.exports = { Store, STATUSES, TAG_RETRY_LIMIT };
