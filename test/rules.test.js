'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RULES, AWARD_BACKOFF_SECONDS, MAX_AWARD_ATTEMPTS, RELEASE_SAFETY_LIMIT_SECONDS, worstCaseSeconds, rulesFromEnv } = require('../src/rules');

test('fixed rules: 60 s delay, 3 min max wait, linc-app tags', () => {
  assert.equal(RULES.delaySeconds, 60);
  assert.equal(RULES.maxWaitSeconds, 180);
  assert.deepEqual(RULES.routedTags, ['Linc Manual', 'Linc Queue', 'Wonderpack Fulfilment Queue', 'Wonderpack Helm Queue', 'Synergy Fulfilment Queue', 'ILG Fulfilment Queue', 'ShipHero Queue']);
  assert.deepEqual(RULES.releasedTags, ['Linc', 'ILG_RELEASED', 'Synergy Fulfilment', 'Wonderpack Fulfilment']);
});

test('timing budget: even the worst case ends at least 2 minutes before Linc releases an order (10 min)', () => {
  assert.equal(MAX_AWARD_ATTEMPTS, 3);
  assert.deepEqual(AWARD_BACKOFF_SECONDS, [30, 90, 270]);
  // delay 60 + wait 180 + retry waits 30 + 90 + 3 attempts x 20 s allowance = 420 s
  assert.equal(worstCaseSeconds(RULES), 420);
  assert.equal(RELEASE_SAFETY_LIMIT_SECONDS, 480);
  assert.ok(worstCaseSeconds(RULES) <= RELEASE_SAFETY_LIMIT_SECONDS);
});

test('env can change the delay and max wait (developers only), within limits', () => {
  assert.equal(rulesFromEnv({}).rules.delaySeconds, 60);
  const ok = rulesFromEnv({ DELAY_SECONDS: '20', MAX_WAIT_SECONDS: '120' });
  assert.deepEqual([ok.errors, ok.rules.delaySeconds, ok.rules.maxWaitSeconds], [[], 20, 120]);
  assert.equal(rulesFromEnv({ DELAY_SECONDS: '0' }).rules.delaySeconds, 0, '0 is allowed (tests)');
});

test('env values that are not whole numbers, are out of range, or break the budget are errors', () => {
  assert.match(rulesFromEnv({ DELAY_SECONDS: 'abc' }).errors[0], /DELAY_SECONDS/);
  assert.match(rulesFromEnv({ DELAY_SECONDS: '-1' }).errors[0], /DELAY_SECONDS/);
  assert.match(rulesFromEnv({ MAX_WAIT_SECONDS: '5000' }).errors[0], /MAX_WAIT_SECONDS/);
  const slow = rulesFromEnv({ DELAY_SECONDS: '240', MAX_WAIT_SECONDS: '240' });
  assert.ok(slow.errors.some((e) => /Linc releases/.test(e)), slow.errors.join(' | '));
});

test('rules are not shared: changing one copy does not change the defaults', () => {
  const a = rulesFromEnv({}).rules;
  a.routedTags.push('X');
  assert.equal(RULES.routedTags.includes('X'), false);
});
