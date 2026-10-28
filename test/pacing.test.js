'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { windowInfo, pacing, timeline } = require('../src/pacing');

const settings = { startsAt: '2026-11-06T07:00:00.000Z', endsAt: '2026-11-06T19:00:00.000Z', cap: 500, oneInN: 20, estimatedOrders: 10000 };
const at = (hhmm) => new Date(`2026-11-06T${hhmm}:00.000Z`);

test('window before, during and after', () => {
  const before = windowInfo(settings, at('06:00'));
  assert.equal(before.state, 'not_started');
  assert.equal(before.msToStart, 3600000);
  assert.equal(before.hoursLeft, 12);

  const during = windowInfo(settings, at('10:00'));
  assert.equal(during.state, 'open');
  assert.equal(during.totalHours, 12);
  assert.equal(during.hoursElapsed, 3);
  assert.equal(during.hoursLeft, 9);
  assert.equal(during.msToEnd, 9 * 3600000);

  const after = windowInfo(settings, at('19:00'));
  assert.equal(after.state, 'ended');
  assert.equal(after.hoursLeft, 0);
  assert.equal(after.msToEnd, 0);
});

test('isOpen treats the end as exclusive and the start as inclusive', () => {
  assert.equal(windowInfo(settings, at('07:00')).state, 'open');
  assert.equal(windowInfo(settings, new Date('2026-11-06T18:59:59.999Z')).state, 'open');
});

test('before 30 minutes have passed the estimate is used', () => {
  const p = pacing(settings, { candidates: 10, winners: 0, now: at('07:10') });
  assert.equal(p.basis, 'estimate');
  // 10000 orders over 12 h; ~11.83 h left -> ~9861 orders; 500 trays -> N = 19
  assert.equal(p.suggestedOneInN, 19);
  assert.equal(p.probabilityPct, 5);
});

test('after 30 minutes the observed rate is used', () => {
  // 3 h in, 2400 candidates -> 800/h, 9 h left -> 7200 more; 400 trays left -> N = 18
  const p = pacing(settings, { candidates: 2400, winners: 100, now: at('10:00') });
  assert.equal(p.basis, 'observed');
  assert.equal(p.ratePerHour, 800);
  assert.equal(p.expectedRemainingOrders, 7200);
  assert.equal(p.suggestedOneInN, 18);
  // at the current 1 in 20: 100 + 7200/20 = 460
  assert.equal(p.projectedWinners, 460);
});

test('projected winners never exceed the cap', () => {
  const p = pacing({ ...settings, oneInN: 2 }, { candidates: 2400, winners: 100, now: at('10:00') });
  assert.equal(p.projectedWinners, 500);
});

test('N never drops below 1 and is null when nothing is left to pace', () => {
  assert.equal(pacing(settings, { candidates: 100, winners: 0, now: at('18:00') }).suggestedOneInN, 1);
  assert.equal(pacing(settings, { candidates: 100, winners: 500, now: at('10:00') }).suggestedOneInN, null);
  assert.equal(pacing(settings, { candidates: 100, winners: 10, now: at('19:30') }).suggestedOneInN, null);
});

test('before the window opens the full estimate is expected', () => {
  const p = pacing(settings, { candidates: 0, winners: 0, now: at('05:00') });
  assert.equal(p.expectedRemainingOrders, 10000);
  assert.equal(p.suggestedOneInN, 20);
});

test('timeline buckets: eligible by created time, winners by won time, ideal line', () => {
  const rows = [
    { created_at: '2026-11-06T07:05:00.000Z', status: 'lost', tray_added_at: null },
    { created_at: '2026-11-06T07:10:00.000Z', status: 'won', tray_added_at: '2026-11-06T07:12:00.000Z' },
    { created_at: '2026-11-06T07:20:00.000Z', status: 'won', tray_added_at: '2026-11-06T07:31:00.000Z' },
    { created_at: '2026-11-06T07:40:00.000Z', status: 'not_eligible', tray_added_at: null },
  ];
  const t = timeline(settings, rows, { bucketMinutes: 30, now: at('08:00') });
  assert.equal(t.buckets.length, 2);
  assert.deepEqual(t.buckets[0], { start: '2026-11-06T07:00:00.000Z', eligible: 3, winners: 1, cumulativeWinners: 1, idealCumulative: 20.83 });
  assert.equal(t.buckets[1].eligible, 0);
  assert.equal(t.buckets[1].winners, 1);
  assert.equal(t.buckets[1].cumulativeWinners, 2);
  assert.equal(t.buckets[1].idealCumulative, 41.67);
});

test('timeline before the window has no buckets; after it covers the whole window', () => {
  assert.equal(timeline(settings, [], { bucketMinutes: 60, now: at('05:00') }).buckets.length, 0);
  assert.equal(timeline(settings, [], { bucketMinutes: 60, now: new Date('2026-11-07T00:00:00Z') }).buckets.length, 12);
});

test('with fewer than 20 orders seen the estimate is used, even late (broken webhook must not push N to 1)', () => {
  const p = pacing(settings, { candidates: 0, winners: 0, now: at('09:00') });
  assert.equal(p.basis, 'estimate');
  // 10000 / 12 h * 10 h left = 8333; 500 trays -> 16
  assert.equal(p.suggestedOneInN, 16);
});
