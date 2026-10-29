'use strict';

// Entry point: config → database → Shopify → engine → HTTP + background jobs.

const { loadConfig, checkConfig } = require('./config');
const { createLogger } = require('./logger');
const { Store } = require('./store');
const { ShopifyClient } = require('./shopify/client');
const { ShopifyOps } = require('./shopify/operations');
const { Engine } = require('./engine');
const { Jobs } = require('./jobs');
const { createApp } = require('./http/app');
const { version } = require('../package.json');

async function main() {
  const config = loadConfig();
  const logger = createLogger();
  const { errors, warnings } = checkConfig(config);
  for (const warning of warnings) logger.warn(warning);
  if (errors.length) {
    for (const error of errors) logger.error(error);
    process.exit(1);
  }

  const store = await Store.open(config.database.url, { authToken: config.database.authToken, seed: config.seed, cacheMs: config.database.cacheMs });
  const client = new ShopifyClient({ ...config.shopify, logger });
  const engine = new Engine({ store, shopify: new ShopifyOps(client), config, logger, authMode: client.authMode, version });
  // No recovery here: the copy that takes the leader lease puts unfinished awards back in the queue
  // (Engine.leadershipTick), so a second copy starting during a deploy can not disturb the running one.

  const jobs = new Jobs({ engine, logger, intervals: { tickMs: config.worker.tickMs, backfillMs: config.worker.backfillMs } });
  const app = createApp({ engine, config, logger });
  const server = app.listen(config.port, async () => {
    const s = await store.getSettings();
    logger.info('golden tray app started', {
      port: config.port, store: config.shopify.domain, mode: s.mode, window: `${s.startsAt} → ${s.endsAt}`,
      db: config.database.url.startsWith('file:') ? config.database.url : config.database.url.replace(/\/\/[^/]*@/, '//').split('?')[0],
      auth: client.authMode, instance: engine.instanceId, version,
    });
    jobs.start();
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal });
    const force = setTimeout(() => { logger.error('shutdown timed out'); process.exit(1); }, 25000);
    force.unref();
    server.close();
    await jobs.stop();
    await store.close();
    logger.info('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  createLogger().error('startup failed', { error: error.message });
  process.exit(1);
});
