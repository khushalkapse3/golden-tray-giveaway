'use strict';

// Infrastructure config from env. Campaign settings (window, odds, cap, SKUs...) live in the
// database and are edited from the dashboard; see settings.js.

const path = require('node:path');
const { rulesFromEnv } = require('./rules');

function cleanDomain(value) {
  return String(value || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
}

function loadConfig(env = process.env) {
  const domain = cleanDomain(env.SHOPIFY_DOMAIN);
  const { rules, errors: ruleErrors } = rulesFromEnv(env);
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const databaseUrl = String(env.DATABASE_URL || '').trim() || `file:${path.join(dataDir, 'golden-tray.db')}`;
  const remote = !databaseUrl.startsWith('file:') && databaseUrl !== ':memory:';
  // The heavy dashboard reads are reused for a few seconds on a hosted database (free-plan row budget).
  const cacheMs = Math.min(Math.max(env.READ_CACHE_MS !== undefined && env.READ_CACHE_MS !== '' ? parseInt(env.READ_CACHE_MS, 10) || 0 : (remote ? 8000 : 0), 0), 60000);
  return {
    database: { url: databaseUrl, authToken: env.DATABASE_AUTH_TOKEN || '', cacheMs },
    rules,
    ruleErrors,
    env: env.NODE_ENV || 'development',
    port: parseInt(env.PORT, 10) || 3100,
    dataDir,
    publicUrl: String(env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    adminPassword: env.ADMIN_PASSWORD || '',
    adminToken: env.ADMIN_TOKEN || '',
    sessionSecret: env.SESSION_SECRET || '',
    shopify: {
      domain,
      apiVersion: env.SHOPIFY_API_VERSION || '2026-10',
      accessToken: env.SHOPIFY_ACCESS_TOKEN || '',
      clientId: env.SHOPIFY_CLIENT_ID || '',
      clientSecret: env.SHOPIFY_CLIENT_SECRET || '',
      // Webhooks an app registers through the API are signed with the app's client secret.
      webhookSecret: env.SHOPIFY_WEBHOOK_SECRET || env.SHOPIFY_CLIENT_SECRET || '',
      adminStoreHandle: env.SHOPIFY_ADMIN_STORE_HANDLE || domain.replace(/\.myshopify\.com$/, ''),
      // Local end-to-end testing against a fake Shopify (scripts/fake-shopify.js). Never in production.
      baseUrl: env.SHOPIFY_BASE_URL || '',
    },
    // Only used to seed settings on the very first boot.
    seed: {
      traySku: env.GOLDEN_TRAY_SKU || '',
      trayVariantId: env.GOLDEN_TRAY_VARIANT_ID || '',
    },
    worker: {
      tickMs: parseInt(env.WORKER_TICK_MS, 10) || 2000,
      concurrency: Math.min(parseInt(env.WORKER_CONCURRENCY, 10) || 6, 20),
      // How often the backfill looks for orders the webhook missed (floor 5 s).
      backfillMs: Math.max(parseInt(env.BACKFILL_INTERVAL_MS, 10) || 180000, 5000),
    },
  };
}

/** Returns {errors, warnings}; the server refuses to start on errors. */
function checkConfig(config) {
  const errors = [...(config.ruleErrors || [])];
  const warnings = [];
  if (!config.shopify.domain) errors.push('SHOPIFY_DOMAIN is required (e.g. my-store.myshopify.com)');
  const hasToken = Boolean(config.shopify.accessToken);
  const hasClientCredentials = Boolean(config.shopify.clientId && config.shopify.clientSecret);
  if (!hasToken && !hasClientCredentials) {
    errors.push('Set SHOPIFY_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET');
  }
  if (!config.adminPassword) errors.push('ADMIN_PASSWORD is required (dashboard login)');
  const dbUrl = config.database.url;
  const dbRemote = !dbUrl.startsWith('file:') && dbUrl !== ':memory:';
  if (!/^(libsql|https?|wss?|file):/.test(dbUrl) && dbUrl !== ':memory:') errors.push('DATABASE_URL must start with libsql:// (Turso), file: or be :memory:');
  else if (dbRemote && !config.database.authToken) errors.push('DATABASE_AUTH_TOKEN is required with a Turso DATABASE_URL');
  if (!dbRemote && config.env === 'production') warnings.push('The database is a local file: it is lost on every deploy unless a persistent disk is attached. Use DATABASE_URL=libsql://... (Turso) instead.');
  if (config.shopify.baseUrl && config.env === 'production') errors.push('SHOPIFY_BASE_URL is for local testing only; remove it in production');
  if (config.shopify.baseUrl) warnings.push(`Talking to a FAKE Shopify at ${config.shopify.baseUrl} (SHOPIFY_BASE_URL)`);
  if (!config.shopify.webhookSecret) {
    warnings.push('No SHOPIFY_WEBHOOK_SECRET or SHOPIFY_CLIENT_SECRET: webhooks will be rejected (backfill still works)');
  }
  if (!config.sessionSecret) warnings.push('No SESSION_SECRET: a random one is used, so logins end on every restart');
  if (!config.publicUrl) warnings.push('No PUBLIC_URL: the webhook can not be registered from the dashboard');
  return { errors, warnings };
}

module.exports = { loadConfig, checkConfig, cleanDomain };
