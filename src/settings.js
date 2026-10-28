'use strict';

// Campaign settings: defaults, validation and the live locks. The database holds the current
// values; the dashboard changes them through PATCH /api/settings.

const DEFAULTS = Object.freeze({
  campaignName: 'Golden tray giveaway',
  mode: 'off',
  startsAt: '2026-11-06T07:00:00.000Z', // 07:00 UK; 6 Nov 2026 is GMT
  endsAt: '2026-11-06T19:00:00.000Z',
  oneInN: 20,
  cap: 500,
  estimatedOrders: 10000,
  minSubtotal: 35,
  allowTestOrders: false,
  traySku: '',
  trayVariantId: '',
  qualifyingSkus: ['FG1527d_V1'],
  tag: 'GoldenTrayNov2026',
  allowedCountries: ['GB', 'GG', 'JE', 'IM'],
  discountDescription: 'Golden tray giveaway',
});

const LOCKED_WHILE_LIVE = ['traySku', 'trayVariantId', 'qualifyingSkus', 'tag', 'allowedCountries'];

class SettingsError extends Error {
  constructor(field, message, { status = 400, code = 'invalid', problems } = {}) {
    super(message);
    this.name = 'SettingsError';
    this.field = field;
    this.status = status;
    this.code = code;
    if (problems) this.problems = problems;
  }
}

const fail = (field, message) => { throw new SettingsError(field, message); };

function int(min, max) {
  return (value, field) => {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isInteger(n)) fail(field, `${field} must be a whole number`);
    if (n < min || (max !== undefined && n > max)) fail(field, `${field} must be between ${min} and ${max ?? '∞'}`);
    return n;
  };
}

function num(min) {
  return (value, field) => {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) fail(field, `${field} must be a number`);
    if (n < min) fail(field, `${field} must be at least ${min}`);
    return n;
  };
}

function bool(value, field) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fail(field, `${field} must be true or false`);
}

function iso(value, field) {
  const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) fail(field, `${field} must be a date and time`);
  return date.toISOString();
}

function str(min, max) {
  return (value, field) => {
    if (typeof value !== 'string') fail(field, `${field} must be text`);
    const s = value.trim();
    if (s.length < min || s.length > max) fail(field, `${field} must be ${min}-${max} characters`);
    return s;
  };
}

function list({ min = 0, upper = false, pattern, what = 'value' } = {}) {
  return (value, field) => {
    const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
    if (!items) fail(field, `${field} must be a list`);
    const out = [...new Set(items.map((v) => String(v).trim()).filter(Boolean).map((v) => (upper ? v.toUpperCase() : v)))];
    if (out.length < min) fail(field, `${field} needs at least ${min} ${what}`);
    if (pattern && out.some((v) => !pattern.test(v))) fail(field, `${field} has an invalid ${what}`);
    return out;
  };
}

function variantId(value, field) {
  if (value === '' || value === null) return '';
  const s = String(value).trim().replace(/^gid:\/\/shopify\/ProductVariant\//, '');
  if (!/^\d+$/.test(s)) fail(field, `${field} must be a numeric variant id`);
  return s;
}

const VALIDATORS = {
  campaignName: str(1, 80),
  mode: (value, field) => (['off', 'shadow', 'live'].includes(value) ? value : fail(field, 'mode must be off, shadow or live')),
  startsAt: iso,
  endsAt: iso,
  oneInN: int(1, 1000000),
  cap: int(0, 1000000),
  estimatedOrders: int(1, 10000000),
  minSubtotal: num(0),
  allowTestOrders: bool,
  traySku: (value, field) => (value === '' ? '' : str(1, 100)(value, field)),
  trayVariantId: variantId,
  qualifyingSkus: list({ min: 1, what: 'SKU' }),
  tag: str(1, 40),
  allowedCountries: list({ min: 1, upper: true, pattern: /^[A-Z]{2}$/, what: 'country code' }),
  discountDescription: str(1, 80),
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function seedDefaults(seed = {}) {
  return {
    ...DEFAULTS,
    traySku: seed.traySku ? String(seed.traySku).trim() : '',
    trayVariantId: seed.trayVariantId ? variantId(seed.trayVariantId, 'trayVariantId') : '',
  };
}

/**
 * Validates a partial update against the current settings.
 * Returns {next, changed, warnings}; throws SettingsError (400 invalid, 409 locked_while_live).
 * context: {winners, now} for warnings only.
 */
function validatePatch(patch, current, context = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new SettingsError(null, 'Nothing to update');
  }
  const next = { ...current };
  for (const [field, value] of Object.entries(patch)) {
    const validate = VALIDATORS[field];
    if (!validate) fail(field, `Unknown setting: ${field}`);
    next[field] = validate(value, field);
  }
  if (new Date(next.endsAt) <= new Date(next.startsAt)) fail('endsAt' in patch ? 'endsAt' : 'startsAt', 'The window must end after it starts');

  const changed = Object.keys(patch).filter((field) => !same(next[field], current[field]));

  // Identity of the campaign must not move under a live giveaway, unless this same patch leaves live.
  if (current.mode === 'live' && next.mode === 'live') {
    const locked = changed.find((field) => LOCKED_WHILE_LIVE.includes(field));
    if (locked) throw new SettingsError(locked, `${locked} can not change while the giveaway is live`, { status: 409, code: 'locked_while_live' });
  }

  const warnings = [];
  const now = context.now || new Date();
  if (context.winners !== undefined && next.cap < context.winners) {
    warnings.push(`The cap (${next.cap}) is below the ${context.winners} winners so far: no more trays will be given`);
  }
  if (new Date(next.endsAt) <= now) warnings.push('The window has already ended: no order will qualify');
  if (next.mode !== 'off' && (!next.traySku || !next.trayVariantId)) warnings.push('Tray SKU and variant id are not set');
  return { next, changed, warnings };
}

module.exports = { DEFAULTS, LOCKED_WHILE_LIVE, SettingsError, validatePatch, seedDefaults };
