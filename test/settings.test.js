'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, LOCKED_WHILE_LIVE, validatePatch, SettingsError, seedDefaults } = require('../src/settings');

const base = () => ({ ...DEFAULTS, traySku: 'GT-TRAY', trayVariantId: '123' });

test('defaults are safe: off, 6 Nov 07:00-19:00Z, 1 in 20, cap 500', () => {
  assert.equal(DEFAULTS.mode, 'off');
  assert.equal(DEFAULTS.startsAt, '2026-11-06T07:00:00.000Z');
  assert.equal(DEFAULTS.endsAt, '2026-11-06T19:00:00.000Z');
  assert.equal(DEFAULTS.oneInN, 20);
  assert.equal(DEFAULTS.cap, 500);
  assert.equal(DEFAULTS.minSubtotal, 35);
  assert.deepEqual(DEFAULTS.qualifyingSkus, ['FG1527d_V1']);
  assert.deepEqual(DEFAULTS.allowedCountries, ['GB', 'GG', 'JE', 'IM']);
});

test('developer-only rules are not settings: nobody can change them through the API', () => {
  for (const field of ['delaySeconds', 'maxWaitSeconds', 'routedTags', 'releasedTags', 'backfill', 'autoPace', 'autoPaceEveryMinutes', 'autoPaceMinN', 'autoPaceMaxN']) {
    assert.equal(field in DEFAULTS, false, `${field} should not be a setting`);
    assert.throws(() => validatePatch({ [field]: 1 }, base()), (e) => e instanceof SettingsError && e.field === field && /Unknown setting/.test(e.message));
  }
});

test('seedDefaults takes tray SKU and variant from env seed only', () => {
  const seeded = seedDefaults({ traySku: 'GT-1', trayVariantId: 'gid://shopify/ProductVariant/987' });
  assert.equal(seeded.traySku, 'GT-1');
  assert.equal(seeded.trayVariantId, '987');
});

test('a valid partial patch returns the merged settings and the changed keys', () => {
  const { next, changed } = validatePatch({ oneInN: '25', cap: 400 }, base());
  assert.equal(next.oneInN, 25);
  assert.equal(next.cap, 400);
  assert.deepEqual(changed.sort(), ['cap', 'oneInN']);
});

test('unchanged values are not reported as changed', () => {
  const { changed } = validatePatch({ oneInN: 20 }, base());
  assert.deepEqual(changed, []);
});

for (const [patch, field] of [
  [{ oneInN: 0 }, 'oneInN'],
  [{ oneInN: 2.5 }, 'oneInN'],
  [{ cap: -1 }, 'cap'],
  [{ minSubtotal: 'abc' }, 'minSubtotal'],
  [{ mode: 'on' }, 'mode'],
  [{ startsAt: 'not a date' }, 'startsAt'],
  [{ endsAt: '2026-11-06T06:00:00Z' }, 'endsAt'],
  [{ qualifyingSkus: [] }, 'qualifyingSkus'],
  [{ allowedCountries: ['GBR'] }, 'allowedCountries'],
  [{ trayVariantId: 'abc' }, 'trayVariantId'],
  [{ nope: 1 }, 'nope'],
]) {
  test(`rejects ${JSON.stringify(patch)} on field ${field}`, () => {
    assert.throws(() => validatePatch(patch, base()), (error) => {
      assert.ok(error instanceof SettingsError);
      assert.equal(error.status, 400);
      assert.equal(error.field, field);
      return true;
    });
  });
}

test('an empty patch is rejected', () => {
  assert.throws(() => validatePatch({}, base()), (e) => e instanceof SettingsError && e.status === 400);
});

test('lists accept a comma string, trim, drop blanks and upper-case countries', () => {
  const { next } = validatePatch({ qualifyingSkus: ' FG1527d_V1, ,FG2 ', allowedCountries: 'gb, je' }, base());
  assert.deepEqual(next.qualifyingSkus, ['FG1527d_V1', 'FG2']);
  assert.deepEqual(next.allowedCountries, ['GB', 'JE']);
});

test('booleans accept true/false and "true"/"false"', () => {
  assert.equal(validatePatch({ allowTestOrders: 'true' }, base()).next.allowTestOrders, true);
  assert.equal(validatePatch({ allowTestOrders: false }, { ...base(), allowTestOrders: true }).next.allowTestOrders, false);
  assert.throws(() => validatePatch({ allowTestOrders: 'yes' }, base()), SettingsError);
});

test('times are stored as normalised ISO strings', () => {
  const { next } = validatePatch({ startsAt: '2026-11-06T07:00:00Z' }, base());
  assert.equal(next.startsAt, '2026-11-06T07:00:00.000Z');
});

test('a gid variant id is stored as the numeric id', () => {
  assert.equal(validatePatch({ trayVariantId: 'gid://shopify/ProductVariant/555' }, base()).next.trayVariantId, '555');
});

test('campaign identity fields are locked while live (409)', () => {
  const live = { ...base(), mode: 'live' };
  for (const field of LOCKED_WHILE_LIVE) {
    const value = Array.isArray(live[field]) ? [...live[field], field === 'allowedCountries' ? 'FR' : 'X1'] : '999';
    assert.throws(() => validatePatch({ [field]: value }, live), (e) => e.status === 409 && e.field === field && e.code === 'locked_while_live');
  }
});

test('locked fields can change in the same patch that leaves live', () => {
  const live = { ...base(), mode: 'live' };
  const { next } = validatePatch({ mode: 'off', traySku: 'GT-2' }, live);
  assert.equal(next.traySku, 'GT-2');
});

test('odds and cap can change while live', () => {
  const live = { ...base(), mode: 'live' };
  assert.equal(validatePatch({ oneInN: 10, cap: 450 }, live).next.oneInN, 10);
});

test('warnings: cap below winners so far, window already ended', () => {
  const { warnings } = validatePatch(
    { cap: 3, endsAt: '2026-10-01T00:00:00Z', startsAt: '2026-09-30T00:00:00Z' },
    base(),
    { winners: 10, now: new Date('2026-10-28T00:00:00Z') },
  );
  assert.ok(warnings.some((w) => /cap/i.test(w)));
  assert.ok(warnings.some((w) => /ended/i.test(w)));
});
