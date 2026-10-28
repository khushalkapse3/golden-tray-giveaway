'use strict';

// Entry point: config → database → Shopify → engine → HTTP + background jobs.

const path = require('node:path');
const { loadConfig, checkConfig } = require('./config');
const { createLogger } = require('./logger');
const { Store } = require('./store');
const { ShopifyClient } = require('./shopify/client');
const { ShopifyOps } = require('./shopify/operations');
const { Engine } = require('./engine');
const { Jobs } = require('./jobs');
const { createApp } = require('./http/app');
const { version } = require('../package.json');

function main() {
  const config = loadConfig();
  const logger = createLogger();
  const { errors, warnings } = checkConfig(config);
  for (const warning of warnings) logger.warn(warning);
  if (errors.length) {
    for (const error of errors) logger.error(error);
    process.exit(1);
  }

  const store = new Store(path.join(config.dataDir, 'golden-tray.db'), { seed: config.seed });
  const client = new ShopifyClient({ ...config.shopify, logger });
  const engine = new Engine({ store, shopify: new ShopifyOps(client), config, logger, authMode: client.authMode, version });
  const recovered = engine.recover();
  if (recovered) logger.warn('put awards cut off by the last shutdown back in the queue', { count: recovered });

  const jobs = new Jobs({ engine, logger, intervals: { tickMs: config.worker.tickMs, backfillMs: config.worker.backfillMs } });
  const app = createApp({ engine, config, logger });
  const server = app.listen(config.port, () => {
    const s = store.getSettings();
    logger.info('golden tray app started', {
      port: config.port, store: config.shopify.domain, mode: s.mode, window: `${s.startsAt} → ${s.endsAt}`,
      db: path.join(config.dataDir, 'golden-tray.db'), auth: client.authMode, version,
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
    store.close();
    logger.info('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
