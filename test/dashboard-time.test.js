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
