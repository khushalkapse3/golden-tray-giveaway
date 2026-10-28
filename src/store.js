'use strict';

// SQLite storage (built-in node:sqlite). One process owns the file, and every call here is
// synchronous, so a read-then-write inside one method can not interleave with another request:
// that is what makes the cap claim atomic.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
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
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, level TEXT NOT NULL, type TEXT NOT NULL,
  order_id TEXT, order_name TEXT, actor TEXT, message TEXT, data TEXT
);
`;

const plain = (row) => (row ? { ...row } : row);
const nowIso = () => new Date().toISOString();
const show = (value) => (Array.isArray(value) ? value.join(', ') : String(value));

class Store {
  constructor(file, { seed = {} } = {}) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM settings').get();
    if (n === 0) this.writeSettings(seedDefaults(seed));
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // --- settings ---------------------------------------------------------------------------

  getSettings() {
    const settings = { ...DEFAULTS };
    for (const { key, value } of this.db.prepare('SELECT key, value FROM settings').all()) {
      if (key in DEFAULTS) settings[key] = JSON.parse(value);
    }
    return settings;
  }

  writeSettings(settings) {
    const upsert = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.transaction(() => {
      for (const key of Object.keys(DEFAULTS)) upsert.run(key, JSON.stringify(settings[key]));
    });
  }

  saveSettings(next, { actor = 'system', changed = [], previous } = {}) {
    const before = previous || this.getSettings();
    this.writeSettings(next);
    if (changed.length > 0) {
      this.addEvent({
        type: 'settings_changed',
        actor,
        message: changed.map((key) => `${key}: ${show(before[key])} → ${show(next[key])}`).join('; '),
        data: { changed, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, next[k]])) },
      });
    }
    return next;
  }

  kvGet(key) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  }

  kvSet(key, value) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  // --- orders -----------------------------------------------------------------------------

  /** Returns false when the order is already stored (duplicate webhook or backfill). */
  insertOrder(fields) {
    const data = { attempts: 0, rolled: 0, roll_won: 0, commit_attempted: 0, tag_attempts: 0, updated_at: nowIso(), ...fields };
    const columns = ORDER_COLUMNS.filter((c) => data[c] !== undefined);
    const sql = `INSERT OR IGNORE INTO orders (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    return this.db.prepare(sql).run(...columns.map((c) => data[c])).changes === 1;
  }

  getOrder(id) {
    return plain(this.db.prepare('SELECT * FROM orders WHERE id = ?').get(String(id)));
  }

  updateOrder(id, fields) {
    const data = { ...fields, updated_at: nowIso() };
    const columns = Object.keys(data).filter((c) => ORDER_COLUMNS.includes(c) && c !== 'id');
    const sql = `UPDATE orders SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    return this.db.prepare(sql).run(...columns.map((c) => (data[c] === undefined ? null : data[c])), String(id)).changes === 1;
  }

  dueOrders(now, limit, exclude = new Set()) {
    const rows = this.db.prepare("SELECT * FROM orders WHERE status = 'queued' AND process_after <= ? ORDER BY process_after, rowid LIMIT ?")
      .all(now, limit + exclude.size);
    return rows.filter((r) => !exclude.has(r.id)).slice(0, limit).map(plain);
  }

  winnerCount(mode, { includeAwarding = false } = {}) {
    if (mode === 'shadow') {
      return this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE mode = 'shadow' AND status = 'shadow_won'").get().n;
    }
    const statuses = includeAwarding ? "('won', 'awarding')" : "('won')";
    return this.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE mode = 'live' AND status IN ${statuses}`).get().n;
  }

  /** Takes a live slot for a queued order if won + in-progress awards are below the cap. */
  claim(id, cap) {
    return this.transaction(() => {
      if (this.winnerCount('live', { includeAwarding: true }) >= cap) return false;
      return this.db.prepare("UPDATE orders SET status = 'awarding', mode = 'live', updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(nowIso(), String(id)).changes === 1;
    });
  }

  /** Marks the order won with the next slot number for its mode; returns the slot. */
  markWon(id, mode, at) {
    return this.transaction(() => {
      const status = mode === 'shadow' ? 'shadow_won' : 'won';
      const { slot } = this.db.prepare('SELECT COALESCE(MAX(slot), 0) + 1 AS slot FROM orders WHERE mode = ? AND status = ?').get(mode, status);
      const tagNext = new Date(new Date(at).getTime() + 120000).toISOString();
      this.updateOrder(id, {
        status, mode, slot, tray_added_at: at, decided_at: at, last_error: null,
        tag_status: mode === 'live' ? 'pending' : null,
        tag_next_at: mode === 'live' ? tagNext : null,
      });
      return slot;
    });
  }

  counts() {
    // shadow_won is reported as "won" under the shadow mode (API counts have one "won" key).
    const empty = () => ({ received: 0, eligible: 0, tag_failed: 0, ...Object.fromEntries(STATUSES.filter((s) => s !== 'shadow_won').map((s) => [s, 0])) });
    const counts = { live: empty(), shadow: empty() };
    const rows = this.db.prepare(`
      SELECT mode, status, COUNT(*) AS n, SUM(rolled) AS rolled, SUM(tag_status = 'failed') AS tag_failed
      FROM orders WHERE mode IN ('live', 'shadow') GROUP BY mode, status`).all();
    for (const r of rows) {
      const c = counts[r.mode];
      const key = r.status === 'shadow_won' ? 'won' : r.status;
      if (key in c) c[key] += r.n;
      c.received += r.n;
      c.eligible += r.rolled || 0;
      c.tag_failed += r.tag_failed || 0;
    }
    return counts;
  }

  /** Qualifying orders seen in the window (any mode, any outcome but not_eligible). */
  candidateCount(settings) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ? AND status != 'not_eligible'")
      .get(new Date(settings.startsAt).toISOString(), new Date(settings.endsAt).toISOString()).n;
  }

  listOrders({ status, mode, q, limit = 50, offset = 0 } = {}) {
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
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM orders ${clause}`).get(...params).n;
    const items = this.db.prepare(`SELECT * FROM orders ${clause} ORDER BY received_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500), Math.max(parseInt(offset, 10) || 0, 0));
    return { total, items: items.map(plain) };
  }

  winners(mode) {
    const status = mode === 'shadow' ? 'shadow_won' : 'won';
    return this.db.prepare('SELECT * FROM orders WHERE mode = ? AND status = ? ORDER BY slot').all(mode === 'shadow' ? 'shadow' : 'live', status).map(plain);
  }

  timelineRows(mode) {
    return this.db.prepare('SELECT created_at, status, tray_added_at FROM orders WHERE mode = ?').all(mode).map(plain);
  }

  tagRetriesDue(now) {
    return this.db.prepare(`SELECT * FROM orders WHERE status = 'won' AND tag_status IN ('failed', 'pending')
      AND tag_attempts < ? AND tag_next_at <= ? ORDER BY tag_next_at`).all(TAG_RETRY_LIMIT, now).map(plain);
  }

  /** After a crash: awards that were in progress go back to the queue (the slot is free again). */
  recoverAwarding(now) {
    return this.db.prepare("UPDATE orders SET status = 'queued', process_after = ?, updated_at = ? WHERE status = 'awarding'").run(now, now).changes;
  }

  reset(scope) {
    const sql = scope === 'shadow' ? "DELETE FROM orders WHERE mode = 'shadow'" : 'DELETE FROM orders';
    return this.db.prepare(sql).run().changes;
  }

  // --- events -----------------------------------------------------------------------------

  addEvent({ level = 'info', type, orderId = null, orderName = null, actor = null, message = '', data = null, at = nowIso() }) {
    this.db.prepare('INSERT INTO events (at, level, type, order_id, order_name, actor, message, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(at, level, type, orderId === null ? null : String(orderId), orderName, actor, message, data ? JSON.stringify(data) : null);
  }

  listEvents({ limit = 50, before } = {}) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const rows = before
      ? this.db.prepare('SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?').all(Number(before), n)
      : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(n);
    return rows.map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
  }
}

module.exports = { Store, STATUSES, TAG_RETRY_LIMIT };
