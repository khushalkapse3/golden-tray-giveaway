'use strict';

// The dashboard's time helpers (public/app.js exports them when it is loaded by Node).
// Admins switch the whole dashboard between IST and UK time; these must convert both ways exactly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ZONES, zoneById, otherZone, zoneInputToIso, isoToZoneInput, convertInputZone } = require('../public/app.js');

test('two zones: IST (India, default) and UK (London)', () => {
  assert.deepEqual([ZONES.ist.tz, ZONES.ist.label], ['Asia/Kolkata', 'IST']);
  assert.deepEqual([ZONES.uk.tz, ZONES.uk.label], ['Europe/London', 'UK']);
  assert.equal(zoneById('uk'), ZONES.uk);
  assert.equal(zoneById('nonsense'), ZONES.ist, 'unknown or missing saved choice falls back to IST');
  assert.equal(zoneById(null), ZONES.ist);
  assert.equal(otherZone(ZONES.ist), ZONES.uk);
  assert.equal(otherZone(ZONES.uk), ZONES.ist);
});

test('the giveaway window: 07:00-19:00 UK on 6 Nov 2026 is 12:30-00:30 IST', () => {
  assert.equal(zoneInputToIso('2026-11-06T07:00', ZONES.uk.tz).value, '2026-11-06T07:00:00.000Z');
  assert.equal(zoneInputToIso('2026-11-06T19:00', ZONES.uk.tz).value, '2026-11-06T19:00:00.000Z');
  assert.equal(zoneInputToIso('2026-11-06T12:30', ZONES.ist.tz).value, '2026-11-06T07:00:00.000Z');
  assert.equal(zoneInputToIso('2026-11-07T00:30', ZONES.ist.tz).value, '2026-11-06T19:00:00.000Z');
  assert.equal(isoToZoneInput('2026-11-06T07:00:00.000Z', ZONES.uk.tz), '2026-11-06T07:00');
  assert.equal(isoToZoneInput('2026-11-06T07:00:00.000Z', ZONES.ist.tz), '2026-11-06T12:30');
  assert.equal(isoToZoneInput('2026-11-06T19:00:00.000Z', ZONES.ist.tz), '2026-11-07T00:30');
});

test('UK summer time (BST, UTC+1) is handled', () => {
  assert.equal(zoneInputToIso('2026-07-01T12:00', ZONES.uk.tz).value, '2026-07-01T11:00:00.000Z');
  assert.equal(isoToZoneInput('2026-07-01T11:00:00.000Z', ZONES.uk.tz), '2026-07-01T12:00');
  assert.equal(isoToZoneInput('2026-07-01T11:00:00.000Z', ZONES.ist.tz), '2026-07-01T16:30');
});

test('a UK wall-clock time that does not exist (clocks go forward) is rejected; IST has no such gap', () => {
  assert.match(zoneInputToIso('2026-03-29T01:30', ZONES.uk.tz).error, /does not exist/);
  assert.equal(zoneInputToIso('2026-03-29T01:30', ZONES.ist.tz).value, '2026-03-28T20:00:00.000Z');
});

test('an ambiguous UK time (clocks go back) still gives a valid instant', () => {
  const r = zoneInputToIso('2026-10-25T01:30', ZONES.uk.tz);
  assert.ok(r.value && !Number.isNaN(Date.parse(r.value)));
});

test('bad input gives an error, not a crash', () => {
  assert.ok(zoneInputToIso('', ZONES.ist.tz).error);
  assert.ok(zoneInputToIso('tomorrow', ZONES.uk.tz).error);
});

test('switching zone converts a typed-but-unsaved value to the same instant', () => {
  assert.equal(convertInputZone('2026-11-06T12:30', ZONES.ist.tz, ZONES.uk.tz), '2026-11-06T07:00');
  assert.equal(convertInputZone('2026-11-06T07:00', ZONES.uk.tz, ZONES.ist.tz), '2026-11-06T12:30');
  assert.equal(convertInputZone('2026-11-07T00:30', ZONES.ist.tz, ZONES.uk.tz), '2026-11-06T19:00');
});

test('converting back and forth returns the original', () => {
  for (const v of ['2026-11-06T12:30', '2026-07-01T16:30', '2026-12-31T23:59']) {
    const there = convertInputZone(v, ZONES.ist.tz, ZONES.uk.tz);
    assert.equal(convertInputZone(there, ZONES.uk.tz, ZONES.ist.tz), v);
  }
});

test('empty or invalid values are returned unchanged when switching', () => {
  assert.equal(convertInputZone('', ZONES.ist.tz, ZONES.uk.tz), '');
  assert.equal(convertInputZone('junk', ZONES.ist.tz, ZONES.uk.tz), 'junk');
});

test('results do not depend on the computer time zone running the test', () => {
  // The test runner is started under several TZ values by the shell loop in the notes; here just assert the pure result.
  assert.equal(zoneInputToIso('2026-11-06T12:30', ZONES.ist.tz).value, '2026-11-06T07:00:00.000Z');
});

// --- chart axis: label spacing must never make labels overlap -----------------------------------
const { tickStepHours } = require('../public/app.js');

test('tickStepHours: the real 12 hour window on a normal screen keeps hourly or 2-hourly labels', () => {
  assert.ok([1, 2].includes(tickStepHours(12, 1000)));
  assert.equal(tickStepHours(12, 1500), 1);
});

test('tickStepHours: a long window gets sparse labels (the overlap seen on a multi-day window)', () => {
  // ~72 h across 1500 px must not put a label on every hour
  const step = tickStepHours(72, 1500);
  assert.ok(step >= 3, `step ${step}`);
  assert.ok(72 / step <= 1500 / 70, 'at most one label per 70 px');
});

test('tickStepHours: narrower charts get fewer labels', () => {
  assert.ok(tickStepHours(12, 300) >= tickStepHours(12, 900));
});

test('tickStepHours: never more labels than fit (70 px each) for any window and width', () => {
  for (const hours of [1, 6, 12, 24, 48, 72, 168, 720]) {
    for (const width of [200, 300, 500, 800, 1200, 1700]) {
      const step = tickStepHours(hours, width);
      assert.ok([1, 2, 3, 4, 6, 12, 24, 48, 168].includes(step), `step ${step}`);
      if (step < 168) assert.ok(hours / step <= Math.max(width / 70, 1) + 1, `${hours} h in ${width} px with step ${step}`);
    }
  }
});

test('tickStepHours: tiny or invalid inputs fall back to 1', () => {
  assert.equal(tickStepHours(0, 800), 1);
  assert.equal(tickStepHours(NaN, 800), 1);
});
