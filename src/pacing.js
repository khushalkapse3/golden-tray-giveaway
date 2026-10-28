'use strict';

// Window maths and the "what should N be" suggestion. Pure functions.

const HOUR = 3600000;
// Below this many orders the observed rate is noise (or the webhook is broken), so the estimate is used.
const MIN_OBSERVED_CANDIDATES = 20;
const round2 = (n) => Math.round(n * 100) / 100;
const WINNER_STATUSES = new Set(['won', 'shadow_won']);

function windowInfo(settings, now = new Date()) {
  const start = new Date(settings.startsAt).getTime();
  const end = new Date(settings.endsAt).getTime();
  const t = now.getTime();
  const state = t < start ? 'not_started' : t < end ? 'open' : 'ended';
  const elapsed = Math.min(Math.max(t - start, 0), end - start);
  return {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    state,
    totalHours: round2((end - start) / HOUR),
    hoursElapsed: round2(elapsed / HOUR),
    hoursLeft: round2((end - start - elapsed) / HOUR),
    msToStart: Math.max(start - t, 0),
    msToEnd: state === 'ended' ? 0 : end - Math.max(t, start),
  };
}

/**
 * candidates: qualifying orders seen so far in the window (any outcome but not_eligible).
 * winners: trays given so far in the mode being paced.
 * Suggested N = floor(expected orders still to come / trays left). The order rate is the
 * observed one after 30 minutes (and at least 20 orders), the estimate before that.
 */
function pacing(settings, { candidates, winners, now = new Date() }) {
  const w = windowInfo(settings, now);
  const elapsedH = w.hoursElapsed;
  const leftH = w.hoursLeft;
  const observed = elapsedH >= 0.5 && candidates >= MIN_OBSERVED_CANDIDATES;
  const ratePerHour = observed ? candidates / elapsedH : settings.estimatedOrders / w.totalHours;
  const expectedRemainingOrders = Math.round(ratePerHour * leftH);
  const traysLeft = Math.max(settings.cap - winners, 0);
  const suggestedOneInN = traysLeft > 0 && leftH > 0 ? Math.max(1, Math.floor(expectedRemainingOrders / traysLeft)) : null;
  return {
    oneInN: settings.oneInN,
    probabilityPct: round2(100 / settings.oneInN),
    suggestedOneInN,
    ratePerHour: round2(ratePerHour),
    basis: observed ? 'observed' : 'estimate',
    expectedRemainingOrders,
    projectedWinners: Math.min(settings.cap, Math.round(winners + expectedRemainingOrders / settings.oneInN)),
    traysLeft,
  };
}

/** rows: {created_at, status, tray_added_at} for one mode. Buckets run from the start to min(now, end). */
function timeline(settings, rows, { bucketMinutes = 15, now = new Date() } = {}) {
  const start = new Date(settings.startsAt).getTime();
  const end = new Date(settings.endsAt).getTime();
  const step = bucketMinutes * 60000;
  const until = Math.min(now.getTime(), end);
  const buckets = [];
  for (let t = start; t < until; t += step) {
    buckets.push({ start: new Date(t).toISOString(), eligible: 0, winners: 0, cumulativeWinners: 0, idealCumulative: 0 });
  }
  const indexOf = (iso) => {
    if (!iso) return -1;
    const i = Math.floor((new Date(iso).getTime() - start) / step);
    return i >= 0 && i < buckets.length ? i : -1;
  };
  for (const row of rows) {
    if (row.status !== 'not_eligible') {
      const i = indexOf(row.created_at);
      if (i >= 0) buckets[i].eligible += 1;
    }
    if (WINNER_STATUSES.has(row.status)) {
      const i = indexOf(row.tray_added_at);
      if (i >= 0) buckets[i].winners += 1;
    }
  }
  let running = 0;
  buckets.forEach((bucket, i) => {
    running += bucket.winners;
    bucket.cumulativeWinners = running;
    const bucketEnd = Math.min(start + (i + 1) * step, end);
    bucket.idealCumulative = round2((settings.cap * (bucketEnd - start)) / (end - start));
  });
  return { bucketMinutes, window: { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() }, cap: settings.cap, buckets };
}

module.exports = { windowInfo, pacing, timeline, WINNER_STATUSES };
