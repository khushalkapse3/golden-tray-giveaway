'use strict';

// Timers for the engine's background work. Each job never overlaps itself, and an error in one
// job is logged without stopping the others.

const DEFAULT_INTERVALS = {
  tickMs: 2000, // awards and tag retries
  leaderMs: 5000, // renews the lease that lets this copy process orders (it lasts 20 s)
  backfillMs: 180000,
  setupMs: 10 * 60000, // refreshes the cached setup status shown on the dashboard
};

class Jobs {
  constructor({ engine, logger, intervals = {} }) {
    this.engine = engine;
    this.logger = logger;
    this.intervals = { ...DEFAULT_INTERVALS, ...intervals };
    this.timers = [];
    this.keptTimers = [];
    this.busy = new Set();
    this.stopped = true;
  }

  every(name, ms, fn, { keepOnStop = false } = {}) {
    const run = async () => {
      if ((this.stopped && !keepOnStop) || this.busy.has(name)) return;
      this.busy.add(name);
      try {
        await fn();
      } catch (error) {
        this.logger.error(`${name} job failed`, { error: error.message });
      } finally {
        this.busy.delete(name);
      }
    };
    const timer = setInterval(run, ms);
    (keepOnStop ? this.keptTimers : this.timers).push(timer);
    return run;
  }

  start() {
    this.stopped = false;
    this.engine.worker.running = true;
    // The worker does not wait for awards to finish, so a slow Shopify call never blocks new ones.
    // Leadership first: only the copy holding the lease processes orders (see Engine.leadershipTick).
    const leader = this.every('leader', this.intervals.leaderMs, () => this.engine.leadershipTick(), { keepOnStop: true });
    leader();
    this.every('worker', this.intervals.tickMs, () => this.engine.tick({ wait: false }));
    this.every('backfill', this.intervals.backfillMs, () => this.engine.backfillTick());
    const setup = this.every('setup', this.intervals.setupMs, () => this.engine.setupCheck());
    setup();
  }

  /**
   * Graceful stop: no new work starts, awards already in flight finish, and only then is leadership
   * given up (it keeps being renewed meanwhile, so the next copy can not take over half-done work).
   */
  async stop() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.engine.worker.running = false;
    await this.engine.idle();
    for (const timer of this.keptTimers) clearInterval(timer);
    this.keptTimers = [];
    await this.engine.releaseLeadership();
  }
}

module.exports = { Jobs, DEFAULT_INTERVALS };
