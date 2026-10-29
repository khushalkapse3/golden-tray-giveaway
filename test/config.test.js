'use strict';

// Written after config.js (it came before the switch to test-first).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, checkConfig } = require('../src/config');

test('domain is cleaned and the admin store handle derived from it', () => {
  const c = loadConfig({ SHOPIFY_DOMAIN: 'https://Staging-Purdy-Global.myshopify.com/admin', SHOPIFY_ACCESS_TOKEN: 't', ADMIN_PASSWORD: 'p' });
  assert.equal(c.shopify.domain, 'staging-purdy-global.myshopify.com');
  assert.equal(c.shopify.adminStoreHandle, 'staging-purdy-global');
  assert.equal(c.shopify.apiVersion, '2026-10');
  assert.equal(c.port, 3100);
});

test('the webhook secret defaults to the client secret', () => {
  assert.equal(loadConfig({ SHOPIFY_CLIENT_SECRET: 'cs' }).shopify.webhookSecret, 'cs');
  assert.equal(loadConfig({ SHOPIFY_CLIENT_SECRET: 'cs', SHOPIFY_WEBHOOK_SECRET: 'ws' }).shopify.webhookSecret, 'ws');
});

test('PUBLIC_URL loses its trailing slash', () => {
  assert.equal(loadConfig({ PUBLIC_URL: 'https://gt.example.com/' }).publicUrl, 'https://gt.example.com');
});

test('missing domain, auth or password are errors; missing secrets are warnings', () => {
  const { errors } = checkConfig(loadConfig({}));
  assert.equal(errors.length, 3);
  const ok = checkConfig(loadConfig({ SHOPIFY_DOMAIN: 's.myshopify.com', SHOPIFY_CLIENT_ID: 'i', SHOPIFY_CLIENT_SECRET: 's', ADMIN_PASSWORD: 'p' }));
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.warnings.some((w) => /SESSION_SECRET/.test(w)));
  assert.ok(ok.warnings.some((w) => /PUBLIC_URL/.test(w)));
});

test('SHOPIFY_BASE_URL is read for local testing and refused in production', () => {
  assert.equal(loadConfig({ SHOPIFY_BASE_URL: 'http://127.0.0.1:4200' }).shopify.baseUrl, 'http://127.0.0.1:4200');
  const prod = checkConfig(loadConfig({ NODE_ENV: 'production', SHOPIFY_BASE_URL: 'http://x', SHOPIFY_DOMAIN: 's.myshopify.com', SHOPIFY_ACCESS_TOKEN: 't', ADMIN_PASSWORD: 'p' }));
  assert.ok(prod.errors.some((e) => /SHOPIFY_BASE_URL/.test(e)));
});

test('worker intervals come from env, with safe defaults and a floor', () => {
  const d = loadConfig({});
  assert.equal(d.worker.backfillMs, 180000);
  assert.equal(loadConfig({ BACKFILL_INTERVAL_MS: '20000' }).worker.backfillMs, 20000);
  assert.equal(loadConfig({ BACKFILL_INTERVAL_MS: '100' }).worker.backfillMs, 5000, 'never below 5 s (Shopify rate limits)');
});

test('rules: defaults, env overrides, and bad values are startup errors', () => {
  const d = loadConfig({});
  assert.equal(d.rules.delaySeconds, 60);
  assert.equal(d.rules.maxWaitSeconds, 180);
  assert.ok(d.rules.routedTags.includes('Linc Queue'));
  assert.equal(loadConfig({ DELAY_SECONDS: '20' }).rules.delaySeconds, 20);
  const bad = loadConfig({ SHOPIFY_DOMAIN: 's.myshopify.com', SHOPIFY_ACCESS_TOKEN: 't', ADMIN_PASSWORD: 'p', DELAY_SECONDS: '280', MAX_WAIT_SECONDS: '280' });
  assert.ok(checkConfig(bad).errors.some((e) => /Linc releases/.test(e)));
  const worse = loadConfig({ SHOPIFY_DOMAIN: 's.myshopify.com', SHOPIFY_ACCESS_TOKEN: 't', ADMIN_PASSWORD: 'p', DELAY_SECONDS: 'x' });
  assert.ok(checkConfig(worse).errors.some((e) => /DELAY_SECONDS/.test(e)));
});

// --- database ----------------------------------------------------------------------------------

const base = { SHOPIFY_DOMAIN: 's.myshopify.com', SHOPIFY_ACCESS_TOKEN: 't', ADMIN_PASSWORD: 'p' };

test('database: defaults to a local file under DATA_DIR; Turso comes from DATABASE_URL + DATABASE_AUTH_TOKEN', () => {
  const d = loadConfig({ DATA_DIR: '/tmp/gt-data' });
  assert.equal(d.database.url, 'file:/tmp/gt-data/golden-tray.db');
  assert.equal(d.database.authToken, '');
  const t = loadConfig({ DATABASE_URL: ' libsql://gt-khushal.turso.io ', DATABASE_AUTH_TOKEN: 'tok' });
  assert.equal(t.database.url, 'libsql://gt-khushal.turso.io');
  assert.equal(t.database.authToken, 'tok');
});

test('database: a Turso URL without a token is a startup error; a bad scheme too', () => {
  const noToken = checkConfig(loadConfig({ ...base, DATABASE_URL: 'libsql://x.turso.io' }));
  assert.ok(noToken.errors.some((e) => /DATABASE_AUTH_TOKEN/.test(e)));
  const bad = checkConfig(loadConfig({ ...base, DATABASE_URL: 'postgres://x/y' }));
  assert.ok(bad.errors.some((e) => /DATABASE_URL/.test(e)));
  const ok = checkConfig(loadConfig({ ...base, DATABASE_URL: 'libsql://x.turso.io', DATABASE_AUTH_TOKEN: 'tok' }));
  assert.deepEqual(ok.errors, []);
});

test('database: a local file in production is a warning (it is lost on every deploy without a disk)', () => {
  const prodFile = checkConfig(loadConfig({ ...base, NODE_ENV: 'production' }));
  assert.ok(prodFile.warnings.some((w) => /disk|deploy/i.test(w)));
  const prodTurso = checkConfig(loadConfig({ ...base, NODE_ENV: 'production', DATABASE_URL: 'libsql://x.turso.io', DATABASE_AUTH_TOKEN: 't' }));
  assert.ok(!prodTurso.warnings.some((w) => /disk|deploy/i.test(w)));
  const devFile = checkConfig(loadConfig({ ...base, NODE_ENV: 'development' }));
  assert.ok(!devFile.warnings.some((w) => /disk|deploy/i.test(w)));
});

test('read cache: 8 s by default for a remote database, 0 for a local file; READ_CACHE_MS overrides it', () => {
  assert.equal(loadConfig({ DATABASE_URL: 'libsql://x.turso.io', DATABASE_AUTH_TOKEN: 't' }).database.cacheMs, 8000);
  assert.equal(loadConfig({}).database.cacheMs, 0);
  assert.equal(loadConfig({ READ_CACHE_MS: '3000' }).database.cacheMs, 3000);
  assert.equal(loadConfig({ DATABASE_URL: 'libsql://x.turso.io', DATABASE_AUTH_TOKEN: 't', READ_CACHE_MS: '0' }).database.cacheMs, 0);
  assert.equal(loadConfig({ READ_CACHE_MS: '999999' }).database.cacheMs, 60000, 'capped at one minute');
});

test('worker concurrency: 6 by default (most orders lose their roll and never call Shopify), env can change it', () => {
  assert.equal(loadConfig({}).worker.concurrency, 6);
  assert.equal(loadConfig({ WORKER_CONCURRENCY: '3' }).worker.concurrency, 3);
  assert.equal(loadConfig({ WORKER_CONCURRENCY: '0' }).worker.concurrency, 6, '0 or junk falls back to the default');
  assert.equal(loadConfig({ WORKER_CONCURRENCY: '500' }).worker.concurrency, 20, 'capped so Shopify is not flooded');
});
