'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Jobs } = require('../src/jobs');

function fakeEngine() {
  const calls = { tick: 0, backfill: 0, setup: 0, idle: 0 };
  return {
    calls,
    worker: { running: false },
    async tick() { calls.tick += 1; return 0; },
    async backfillTick() { calls.backfill += 1; return { ran: false }; },
    async setupCheck() { calls.setup += 1; return { ok: true }; },
    async idle() { calls.idle += 1; },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('runs the worker, backfill and setup check on their intervals, then stops cleanly', async () => {
  const engine = fakeEngine();
  const jobs = new Jobs({ engine, logger: { info() {}, warn() {}, error() {} }, intervals: { tickMs: 10, backfillMs: 30, setupMs: 1000 } });
  jobs.start();
  assert.equal(engine.worker.running, true);
  await wait(75);
  await jobs.stop();
  assert.equal(engine.worker.running, false);
  assert.ok(engine.calls.tick >= 4, `tick ran ${engine.calls.tick}`);
  assert.ok(engine.calls.backfill >= 1);
  assert.equal(engine.calls.setup, 1, 'setup check runs once at start');
  assert.equal(engine.calls.idle, 1, 'waits for awards in flight');
  const after = engine.calls.tick;
  await wait(30);
  assert.equal(engine.calls.tick, after, 'nothing runs after stop');
});

test('a job that throws does not stop the others', async () => {
  const engine = fakeEngine();
  engine.backfillTick = async () => { throw new Error('boom'); };
  const errors = [];
  const jobs = new Jobs({ engine, logger: { info() {}, warn() {}, error: (m) => errors.push(m) }, intervals: { tickMs: 10, backfillMs: 10, setupMs: 1000 } });
  jobs.start();
  await wait(45);
  await jobs.stop();
  assert.ok(errors.length >= 1);
  assert.ok(engine.calls.tick >= 3);
});

test('a slow job is not started again while it is still running', async () => {
  const engine = fakeEngine();
  let running = 0;
  let maxRunning = 0;
  engine.backfillTick = async () => { running += 1; maxRunning = Math.max(maxRunning, running); await wait(40); running -= 1; };
  const jobs = new Jobs({ engine, logger: { info() {}, warn() {}, error() {} }, intervals: { tickMs: 1000, backfillMs: 5, setupMs: 1000 } });
  jobs.start();
  await wait(60);
  await jobs.stop();
  assert.equal(maxRunning, 1);
});
