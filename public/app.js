/* Golden tray admin dashboard. Vanilla JS, no dependencies, CSP-safe (no inline code, no innerHTML). */
(function () {
  'use strict';

  const IS_BROWSER = typeof document !== 'undefined';

  // ================================================================ time zones (IST or UK)
  // The whole dashboard is shown in one of two zones, chosen with the IST / UK switch in the header:
  // IST (Asia/Kolkata, UTC+5:30, no daylight saving; the default, the admins are in India) or UK
  // (Europe/London, GMT/BST; the campaign window is defined in UK time). UTC and the other zone are
  // always shown beside it as hints.

  const ZONES = {
    ist: { id: 'ist', tz: 'Asia/Kolkata', label: 'IST', name: 'IST (India, UTC+5:30)' },
    uk: { id: 'uk', tz: 'Europe/London', label: 'UK', name: 'UK time (London, GMT in winter, BST in summer)' },
  };
  const zoneById = (id) => ZONES[id] || ZONES.ist;
  const otherZone = (z) => (z.id === 'ist' ? ZONES.uk : ZONES.ist);
  /** The zone everything is currently shown in. Changed only by setZone(). */
  let zone = ZONES.ist;
  const dtfCache = new Map();
  function dtf(tz, opts) {
    const key = (tz || 'local') + JSON.stringify(opts);
    let f = dtfCache.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat('en-GB', tz ? Object.assign({ timeZone: tz }, opts) : opts);
      dtfCache.set(key, f);
    }
    return f;
  }

  /** Wall-clock parts of instant `ms` in time zone `tz`. */
  function partsIn(tz, ms) {
    const parts = dtf(tz, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const o = {};
    for (const p of parts) if (p.type !== 'literal') o[p.type] = Number(p.value);
    if (o.hour === 24) o.hour = 0;
    return o;
  }

  /** Offset of `tz` from UTC at instant `ms`, in ms (BST = +3600000, GMT = 0). */
  function tzOffsetMs(tz, ms) {
    const p = partsIn(tz, ms);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  /**
   * "2026-11-06T12:30" read as wall-clock time in zone `tz` (default: the current zone) -> UTC ISO string.
   * Independent of the browser's own time zone. Handles daylight saving, and rejects a wall-clock
   * time that does not exist (the hour skipped when UK clocks go forward).
   */
  function zoneInputToIso(str, tz) {
    const z = tz || zone.tz;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(str || '').trim());
    if (!m) return { error: 'Enter a date and time' };
    const [y, mo, d, hh, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
    const wall = Date.UTC(y, mo - 1, d, hh, mi, 0);
    let utc = wall - tzOffsetMs(z, wall);
    const off2 = tzOffsetMs(z, utc);
    if (off2 !== wall - utc) utc = wall - off2;
    const p = partsIn(z, utc);
    if (p.year !== y || p.month !== mo || p.day !== d || p.hour !== hh || p.minute !== mi) {
      return { error: 'That time does not exist (the clocks change then).' };
    }
    return { value: new Date(utc).toISOString() };
  }

  /** UTC ISO -> "YYYY-MM-DDTHH:MM" in zone `tz` (default: the current zone), for <input type="datetime-local">. */
  function isoToZoneInput(iso, tz) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return '';
    const p = partsIn(tz || zone.tz, ms);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
  }

  /** A typed datetime-local value, moved from one zone to another (same instant). Empty or invalid stays as it is. */
  function convertInputZone(str, fromTz, toTz) {
    const r = zoneInputToIso(str, fromTz);
    return r.error ? str : isoToZoneInput(r.value, toTz);
  }

  function tzAbbr(tz, ms) {
    const part = dtf(tz, { timeZoneName: 'short', hour: 'numeric' }).formatToParts(new Date(ms)).find((x) => x.type === 'timeZoneName');
    return part ? part.value : '';
  }
  const fmtHM = (tz, ms) => dtf(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  const fmtHMS = (tz, ms) => dtf(tz, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  const fmtDay = (tz, ms) => dtf(tz, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms));
  const sameDay = (tz, a, b) => { const x = partsIn(tz, a), y = partsIn(tz, b); return x.year === y.year && x.month === y.month && x.day === y.day; };

  /** "Fri 6 Nov, 09:12:03 GMT · 09:12:03 UTC" for tooltips. */
  function fullStamp(ms) {
    const o = otherZone(zone);
    return `${fmtDay(zone.tz, ms)}, ${fmtHMS(zone.tz, ms)} ${zone.label} · ${fmtDay('UTC', ms)}, ${fmtHMS('UTC', ms)} UTC · ${fmtHMS(o.tz, ms)} ${o.label}`;
  }

  function localTzName() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }
  const LOCAL_TZ = localTzName();
  const localDiffers = () => Boolean(LOCAL_TZ) && LOCAL_TZ !== zone.tz && !(zone.id === 'ist' && LOCAL_TZ === 'Asia/Calcutta');

  function fmtDuration(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}d ${h}h ${pad2(m)}m`;
    if (h > 0) return `${h}h ${pad2(m)}m ${pad2(sec)}s`;
    return `${m}m ${pad2(sec)}s`;
  }

  // Node-only hook so the time helpers can be unit-checked: node -e "require('./public/app.js')"
  if (!IS_BROWSER) {
    if (typeof module !== 'undefined') module.exports = { ZONES, zoneById, otherZone, zoneInputToIso, isoToZoneInput, convertInputZone, tzOffsetMs, partsIn, fmtDuration };
    return;
  }

  // ================================================================ theme (runs before first paint)

  const THEME_KEY = 'goldenTray.theme';
  const root = document.documentElement;
  const mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function storedTheme() { try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; } }
  function storeTheme(t) { try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ } }
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
    else root.removeAttribute('data-theme');
  }
  function effectiveTheme() {
    const t = root.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return mqDark && mqDark.matches ? 'dark' : 'light';
  }
  applyTheme(storedTheme());

  const ZONE_KEY = 'goldenTray.zone';
  function storedZone() { try { return localStorage.getItem(ZONE_KEY); } catch (e) { return null; } }
  function storeZone(id) { try { localStorage.setItem(ZONE_KEY, id); } catch (e) { /* ignore */ } }
  zone = zoneById(storedZone());

  // ================================================================ DOM helpers

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  function appendKids(el, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
  }
  /** Element builder. Strings become text nodes, so data is always escaped. */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    return appendKids(el, Array.prototype.slice.call(arguments, 2));
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] != null) el.setAttribute(k, String(attrs[k]));
    for (const k of Array.prototype.slice.call(arguments, 2)) {
      if (k == null) continue;
      el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
  }
  const clear = (el) => { el.replaceChildren(); return el; };
  function safeUrl(u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? u : null; }

  const nf = new Intl.NumberFormat('en-GB');
  const fmtInt = (n) => (n == null || Number.isNaN(Number(n)) ? '–' : nf.format(Math.round(Number(n))));
  const moneyFmt = new Map();
  function fmtMoney(n, cur) {
    if (n == null || Number.isNaN(Number(n))) return '–';
    const c = cur || 'GBP';
    if (!moneyFmt.has(c)) {
      try { moneyFmt.set(c, new Intl.NumberFormat('en-GB', { style: 'currency', currency: c })); } catch (e) { moneyFmt.set(c, new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2 })); }
    }
    return moneyFmt.get(c).format(Number(n));
  }
  function fmtPct(p) {
    if (p == null || !Number.isFinite(p)) return '–';
    const r = p >= 10 ? Math.round(p * 10) / 10 : Math.round(p * 100) / 100;
    return `${r}%`;
  }
  const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const STATUS_LABEL = {
    queued: 'Queued', not_eligible: 'Not eligible', lost: 'Lost', cap_reached: 'Cap reached', awarding: 'Awarding',
    won: 'Won', shadow_won: 'Shadow won', skipped: 'Skipped', failed: 'Failed',
  };
  const humanize = (s2) => (s2 ? String(s2).replace(/_/g, ' ') : '');

  // ================================================================ state

  const state = {
    me: null,
    status: null,
    serverOffset: 0,
    lastOkAt: 0,
    connError: null,
    winnersMode: 'live',
    winners: [],
    winnersSig: '',
    orders: { status: 'all', mode: '', q: '', offset: 0, limit: 50, total: 0, items: [], sig: '', seq: 0 },
    events: [],
    eventsDone: false,
    eventsSig: '',
    eventsLoaded: false,
    timeline: null,
    setupResult: null,
  };
  const serverNow = () => Date.now() + state.serverOffset;

  // ================================================================ API

  class ApiError extends Error {
    constructor(status, data) {
      super((data && (data.message || data.error)) || `HTTP ${status}`);
      this.status = status;
      this.data = data || {};
    }
  }

  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      throw new ApiError(0, { error: 'network', message: 'Cannot reach the server. Check your connection.' });
    }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { data = await res.json(); } catch (e) { data = null; }
    }
    if (res.status === 401 && path !== '/api/login') {
      onUnauthorized();
      throw new ApiError(401, data || { error: 'unauthorized' });
    }
    if (!res.ok) throw new ApiError(res.status, data || { error: `http_${res.status}` });
    return data;
  }

  function qs(params) {
    const u = new URLSearchParams();
    for (const k of Object.keys(params)) if (params[k] !== '' && params[k] != null) u.set(k, params[k]);
    const str = u.toString();
    return str ? `?${str}` : '';
  }

  function errorMessage(err) {
    const d = (err && err.data) || {};
    switch (d.error) {
      case 'network': return d.message;
      case 'setup_incomplete': return 'Setup is incomplete, so Live was refused.';
      case 'locked_while_live': return `${d.field || 'That setting'} can't be changed while Live.`;
      case 'too_many_attempts': return 'Too many attempts. Wait a minute and try again.';
      case 'bad_password': return 'Wrong password.';
      case 'invalid': return d.message ? `${d.field ? d.field + ': ' : ''}${d.message}` : 'Invalid input.';
      default:
        if (d.message) return d.message;
        if (d.error) return humanize(d.error).replace(/^./, (c) => c.toUpperCase());
        return err && err.message ? err.message : 'Something went wrong.';
    }
  }

  // ================================================================ toasts, busy, modal

  function toast(msg, kind, ms) {
    const box = $('#toasts');
    const k = kind || 'info';
    const el = h('div', { class: `toast toast-${k}` },
      h('div', { class: 'toast-msg' }, msg),
      h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', onclick: () => el.remove() }, '×'));
    box.append(el);
    while (box.children.length > 5) box.firstElementChild.remove();
    setTimeout(() => el.remove(), ms || (k === 'error' ? 9000 : 5000));
  }

  async function withBusy(btn, fn) {
    if (!btn) return fn();
    if (btn.classList.contains('is-busy')) return undefined;
    const wasDisabled = btn.disabled;
    btn.classList.add('is-busy');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try {
      return await fn();
    } finally {
      btn.classList.remove('is-busy');
      btn.removeAttribute('aria-busy');
      btn.disabled = wasDisabled;
    }
  }

  let modalSeq = 0;
  const openModals = [];
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /**
   * Custom modal with focus trap, Escape to close, focus restore.
   * actions: [{id, label, class, disabled, onClick(ctl) -> false to keep open}]
   */
  function openModal(opts) {
    const prevFocus = document.activeElement;
    const titleId = `modal-title-${++modalSeq}`;
    const errBox = h('div', { class: 'alert alert-error', role: 'alert', hidden: true });
    const actionsEl = h('div', { class: 'modal-actions' });
    const dialog = h('div', { class: `modal ${opts.className || ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('h2', { class: 'modal-title', id: titleId }, opts.title),
      h('div', { class: 'modal-body' }, opts.body),
      errBox, actionsEl);
    const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
    let closed = false;
    const ctl = {
      dialog, buttons: {},
      setError(content) {
        clear(errBox);
        if (content == null) { errBox.hidden = true; return; }
        appendKids(errBox, [content]);
        errBox.hidden = false;
        errBox.scrollIntoView({ block: 'nearest' });
      },
      close,
    };
    for (const a of opts.actions || []) {
      const btn = h('button', { type: 'button', class: `btn ${a.class || 'btn-secondary'}` }, a.label);
      if (a.disabled) btn.disabled = true;
      btn.addEventListener('click', async () => {
        if (a.onClick) {
          ctl.setError(null);
          const keep = await withBusy(btn, () => a.onClick(ctl));
          if (keep === false || closed) return;
        }
        close();
      });
      ctl.buttons[a.id || a.label] = btn;
      actionsEl.append(btn);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {
        const f = $$(FOCUSABLE, dialog).filter((x) => x.offsetParent !== null || x === document.activeElement);
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      }
    }
    function close() {
      if (closed) return;
      closed = true;
      backdrop.removeEventListener('keydown', onKey);
      backdrop.remove();
      const i = openModals.indexOf(ctl);
      if (i >= 0) openModals.splice(i, 1);
      if (!openModals.length) { $('#app-view').inert = false; $('#login-view').inert = false; }
      if (opts.onClose) opts.onClose();
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) prevFocus.focus();
    }
    backdrop.addEventListener('keydown', onKey);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && !opts.sticky) close(); });
    $('#app-view').inert = true;
    $('#login-view').inert = true;
    $('#modal-root').append(backdrop);
    openModals.push(ctl);
    const initial = (opts.initialFocus && $(opts.initialFocus, dialog)) || $$(FOCUSABLE, dialog)[0] || dialog;
    if (initial === dialog) dialog.setAttribute('tabindex', '-1');
    initial.focus();
    return ctl;
  }
  function closeAllModals() { openModals.slice().forEach((m) => m.close()); }

  // ================================================================ auth / views

  function showLogin(message) {
    stopPolling();
    closeAllModals();
    state.me = null;
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    const err = $('#login-error');
    if (message) { err.textContent = message; err.hidden = false; } else { err.hidden = true; }
    let remembered = '';
    try { remembered = localStorage.getItem('goldenTray.name') || ''; } catch (e) { /* ignore */ }
    const nameEl = $('#login-name');
    if (!nameEl.value && remembered) nameEl.value = remembered;
    (nameEl.value ? $('#login-password') : nameEl).focus();
  }

  function onUnauthorized() {
    if (state.me) showLogin('Your session has ended. Please sign in again.');
    else if ($('#login-view').hidden) showLogin();
  }

  function showApp(name) {
    state.me = { name };
    $('#user-name').textContent = name;
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#login-password').value = '';
    state.eventsLoaded = false;
    state.events = [];
    state.eventsSig = '';
    state.winnersSig = '';
    state.orders.sig = '';
    startPolling();
  }

  async function onLoginSubmit(e) {
    e.preventDefault();
    const name = $('#login-name').value.trim();
    const password = $('#login-password').value;
    const err = $('#login-error');
    err.hidden = true;
    if (!name) { err.textContent = 'Enter your name. It is shown in the activity log.'; err.hidden = false; $('#login-name').focus(); return; }
    if (!password) { err.textContent = 'Enter the password.'; err.hidden = false; $('#login-password').focus(); return; }
    await withBusy($('#login-submit'), async () => {
      try {
        const res = await api('POST', '/api/login', { name, password });
        try { localStorage.setItem('goldenTray.name', name); } catch (x) { /* ignore */ }
        showApp((res && res.name) || name);
      } catch (ex) {
        err.textContent = ex.status === 401 ? 'Wrong password.' : errorMessage(ex);
        err.hidden = false;
        $('#login-password').select();
      }
    });
  }

  async function logout() {
    try { await api('POST', '/api/logout', {}); } catch (e) { /* ignore */ }
    showLogin();
  }

  // ================================================================ polling

  const POLL_MS = 5000;
  let pollTimer = null;
  let ticking = false;
  let wantFull = false;
  let tickCount = 0;

  function startPolling() { stopPolling(); tickCount = 0; tick(true); }
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  function scheduleNext() {
    clearTimeout(pollTimer);
    if (!state.me || document.hidden) return;
    pollTimer = setTimeout(() => tick(false), POLL_MS);
  }
  /** One refresh. Status every tick; tables and chart every other tick (or when forced). */
  async function tick(full) {
    if (!state.me) return;
    if (ticking) { wantFull = wantFull || full; return; }
    ticking = true;
    clearTimeout(pollTimer);
    try {
      const ok = await refreshStatus();
      if (ok) {
        const jobs = [refreshEvents()];
        if (full || tickCount % 2 === 0) jobs.push(refreshWinners(), refreshOrders(), refreshTimeline());
        await Promise.allSettled(jobs);
      }
      tickCount++;
    } finally {
      ticking = false;
      if (wantFull && state.me) { wantFull = false; tick(true); } else scheduleNext();
    }
  }
  const refreshNow = () => tick(true);

  async function refreshStatus() {
    try {
      const st = await api('GET', '/api/status');
      const t = Date.parse(st.now);
      if (!Number.isNaN(t)) state.serverOffset = t - Date.now();
      state.status = st;
      state.lastOkAt = Date.now();
      state.connError = null;
      renderStatus();
      return true;
    } catch (e) {
      if (e.status === 401) return false;
      state.connError = errorMessage(e);
      renderConn();
      return false;
    }
  }

  // ================================================================ status rendering

  function renderConn() {
    const el = $('#conn-state');
    if (state.connError) {
      el.textContent = 'Connection problem, retrying…';
      el.title = state.connError;
      el.classList.add('is-bad');
    } else if (state.lastOkAt) {
      el.textContent = `Updated ${fmtHMS(zone.tz, state.lastOkAt + state.serverOffset)}`;
      el.title = fullStamp(state.lastOkAt + state.serverOffset);
      el.classList.remove('is-bad');
    }
  }

  function renderStatus() {
    const st = state.status;
    if (!st) return;
    renderConn();
    renderHeader(st);
    renderWindow();
    renderSetupAlert(st);
    renderCards(st);
    renderPacing(st);
    renderRules(st);
    renderSettings(st);
    renderSetupSummary(st);
    renderSystem(st);
    renderDanger(st);
  }

  const MODE_DESC = {
    off: ['Off. ', 'Webhooks are ignored and anything still queued is skipped. Nothing is written to Shopify.'],
    shadow: ['Shadow (dry run). ', 'Orders are rolled and shadow winners are recorded, but nothing is written to Shopify.'],
    live: ['Live. ', 'Winning orders get the tray added at £0 and are tagged in Shopify.'],
  };

  function renderHeader(st) {
    const set = st.settings || {};
    const mode = set.mode || 'off';
    $('#campaign-name').textContent = set.campaignName || 'Golden tray';
    $('#store-name').textContent = (st.shopify && st.shopify.store) || '';
    document.title = `${mode === 'live' ? '● LIVE' : mode === 'shadow' ? 'Shadow' : 'Off'} · ${set.campaignName || 'Golden tray'}`;
    $('.modebar').dataset.mode = mode;
    for (const b of $$('.mode-btn')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    const d = MODE_DESC[mode] || MODE_DESC.off;
    const desc = clear($('#mode-desc'));
    desc.append(h('strong', null, d[0]), d[1]);
    if (mode === 'live' && set.tag) desc.append(' Tag: ', h('strong', null, set.tag), '.');
    $('#footer-version').textContent = `Golden tray ${st.version || ''}`;
  }

  function windowTimes() {
    const st = state.status;
    if (!st) return null;
    const w = st.window || {};
    const startsAt = Date.parse(w.startsAt || st.settings.startsAt);
    const endsAt = Date.parse(w.endsAt || st.settings.endsAt);
    if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) return null;
    return { startsAt, endsAt };
  }

  function rangeText(tz, a, b, suffix) {
    const sameD = sameDay(tz, a, b);
    return sameD
      ? `${fmtDay(tz, a)} · ${fmtHM(tz, a)}–${fmtHM(tz, b)} ${suffix}`
      : `${fmtDay(tz, a)} ${fmtHM(tz, a)} – ${fmtDay(tz, b)} ${fmtHM(tz, b)} ${suffix}`;
  }

  /** Window pill + countdown. Runs every second using the server's clock. */
  function renderWindow() {
    const wt = windowTimes();
    if (!wt) return;
    const now = serverNow();
    const stateName = now < wt.startsAt ? 'not_started' : now < wt.endsAt ? 'open' : 'ended';
    const pill = $('#window-pill');
    pill.className = `pill pill-${stateName}`;
    pill.textContent = stateName === 'open' ? 'Open' : stateName === 'not_started' ? 'Not started' : 'Ended';
    $('#window-countdown').textContent = stateName === 'open' ? `Ends in ${fmtDuration(wt.endsAt - now)}`
      : stateName === 'not_started' ? `Starts in ${fmtDuration(wt.startsAt - now)}` : '';
    const istText = rangeText(zone.tz, wt.startsAt, wt.endsAt, zone.label);
    const utcText = rangeText('UTC', wt.startsAt, wt.endsAt, 'UTC');
    const o = otherZone(zone);
    const ukText = `${fmtHM(o.tz, wt.startsAt)}–${fmtHM(o.tz, wt.endsAt)} ${o.label}`;
    if ($('#window-times').textContent !== istText) $('#window-times').textContent = istText;
    let extra = `${utcText} · ${ukText}`;
    if (localDiffers()) extra += ` · ${fmtHM(null, wt.startsAt)}–${fmtHM(null, wt.endsAt)} your computer (${tzAbbr(null, wt.startsAt)})`;
    if ($('#window-times-utc').textContent !== extra) $('#window-times-utc').textContent = extra;
  }

  function renderSetupAlert(st) {
    const box = $('#setup-alert');
    const setup = st.setup || {};
    if (setup.ok !== false) { box.hidden = true; return; }
    const problems = setup.problems || [];
    clear(box);
    box.append(
      h('div', { class: 'alert-title' }, 'Setup incomplete: switching to Live will be refused.'),
      problems.length ? h('ul', null, problems.map((p) => h('li', null, typeof p === 'string' ? p : (p.message || p.name || JSON.stringify(p))))) : null,
      h('p', { class: 'small' }, 'Fix these, then use "Run checks" in the Setup panel.'));
    box.hidden = false;
  }

  function ring(value, max) {
    const r = 32, c = 2 * Math.PI * r;
    const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    return s('svg', { class: 'ring', viewBox: '0 0 76 76', 'aria-hidden': 'true', focusable: 'false' },
      s('circle', { class: 'ring-track', cx: 38, cy: 38, r }),
      s('circle', { class: 'ring-fill', cx: 38, cy: 38, r, 'stroke-dasharray': c.toFixed(2), 'stroke-dashoffset': (c * (1 - pct)).toFixed(2), transform: 'rotate(-90 38 38)' }),
      s('text', { class: 'ring-text', x: 38, y: 43, 'text-anchor': 'middle' }, `${Math.round(pct * 100)}%`));
  }

  function card(label, value, sub, opts) {
    const o = opts || {};
    return h('div', { class: `card${o.alert ? ' card-alert' : ''}` },
      h('div', { class: 'card-label' }, label),
      h('div', { class: 'card-value' }, value),
      sub ? h('div', { class: 'card-sub', title: o.subTitle || null }, sub) : null);
  }

  function renderCards(st) {
    const m = st.activeMode || 'live';
    const c = (st.counts && st.counts[m]) || {};
    const p = st.pacing || {};
    const set = st.settings || {};
    const cap = set.cap;
    const won = c.won || 0;
    $('#cards-mode').textContent = st.activeMode ? `${m === 'live' ? 'Live' : 'Shadow'} counts` : 'Giveaway off · showing live counts';
    const pctOfCap = cap > 0 ? `${Math.round((won / cap) * 100)}% of cap` : 'cap is 0';
    const hero = h('div', { class: 'card card-hero' },
      ring(won, cap),
      h('div', null,
        h('div', { class: 'card-label' }, m === 'shadow' ? 'Shadow winners / cap' : 'Winners / cap'),
        h('div', { class: 'card-value' }, `${fmtInt(won)} / ${fmtInt(cap)}`),
        h('div', { class: 'card-sub' }, c.awarding ? `${fmtInt(c.awarding)} being awarded · ${pctOfCap}` : pctOfCap)));
    const projected = p.projectedWinners;
    const cards = [
      hero,
      card('Trays left', fmtInt(st.traysLeft), cap ? `of ${fmtInt(cap)}` : null),
      card('Eligible (rolled)', fmtInt(c.eligible), `${fmtInt(c.received)} received · ${fmtInt(c.not_eligible)} not eligible`),
      card('Lost', fmtInt(c.lost), c.cap_reached ? `${fmtInt(c.cap_reached)} after cap reached` : 'rolled, did not win'),
      card('Skipped', fmtInt(c.skipped), 'cancelled, fraud, released…'),
      card('Failed', fmtInt(c.failed), c.tag_failed ? `${fmtInt(c.tag_failed)} tag failures` : 'tag failures: 0', { alert: (c.failed || 0) + (c.tag_failed || 0) > 0 }),
      card('Queued', fmtInt(c.queued), st.worker ? `${fmtInt(st.worker.awarding)} awarding · ${st.worker.running ? 'worker running' : 'worker stopped'}` : null, { alert: st.worker && st.worker.running === false }),
      card('Orders / hour', p.ratePerHour == null ? '–' : fmtInt(p.ratePerHour), p.basis === 'observed' ? 'observed' : 'from estimate'),
      card('Projected winners', fmtInt(projected), `by end at 1 in ${fmtInt(p.oneInN || set.oneInN)}`, { alert: cap > 0 && projected != null && projected < cap * 0.8 && st.window && st.window.state !== 'ended' }),
    ];
    clear($('#cards')).append(...cards);
  }

  // ---------------------------------------------------------------- pacing

  function expectedWinnersAt(n) {
    const st = state.status;
    if (!st || !(n >= 1)) return null;
    const m = st.activeMode || 'live';
    const c = (st.counts && st.counts[m]) || {};
    const remaining = (st.pacing && st.pacing.expectedRemainingOrders) || 0;
    const cap = st.settings.cap || 0;
    return Math.min(cap, Math.round((c.won || 0) + (c.awarding || 0) + remaining / n));
  }

  /** Fixed rules: read-only, set by developers (status.rules). */
  function renderRules(st) {
    const r = st.rules || {};
    const secs = (v) => (v == null ? '–' : v >= 60 && v % 60 === 0 ? `${v} s (${v / 60} min)` : `${v} s`);
    $('#rule-delay').textContent = secs(r.delaySeconds);
    $('#rule-maxwait').textContent = secs(r.maxWaitSeconds);
    for (const [id, tags] of [['#rule-routed', r.routedTags], ['#rule-released', r.releasedTags]]) {
      const list = clear($(id));
      for (const tag of tags || []) list.append(h('li', { class: 'chip' }, tag));
    }
  }

  function renderPacing(st) {
    const p = st.pacing || {};
    const set = st.settings || {};
    const n = p.oneInN || set.oneInN;
    $('#odds-n').textContent = n ? `1 in ${fmtInt(n)}` : '–';
    $('#odds-pct').textContent = n ? `= ${fmtPct(p.probabilityPct != null ? p.probabilityPct : 100 / n)} chance per eligible order` : '';
    const wt = windowTimes();
    $('#pacing-basis').textContent = p.projectedWinners != null && wt
      ? `≈ ${fmtInt(p.projectedWinners)} winners expected by ${fmtHM(zone.tz, wt.endsAt)} ${zone.label} at the current odds`
      : '';

    renderForm($('#n-form'), set);
    updateNPreview();
  }

  function updateNPreview() {
    const el = $('#set-oneInN');
    const out = $('#n-preview');
    const raw = el.value.trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1) { out.textContent = raw ? 'Enter a whole number, 1 or more.' : ''; return; }
    const n = Number(raw);
    const exp = expectedWinnersAt(n);
    const st = state.status;
    const cap = st ? st.settings.cap : null;
    let t = `1 in ${fmtInt(n)} = ${fmtPct(100 / n)}`;
    if (exp != null) t += ` · ≈ ${fmtInt(exp)} winners by the end${cap != null && exp >= cap ? ' (cap reached early)' : ''}`;
    out.textContent = t;
  }

  // ---------------------------------------------------------------- generic settings forms

  function formatValue(type, v) {
    switch (type) {
      case 'bool': return v ? 'true' : 'false';
      case 'list': case 'countries': return Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v));
      case 'datetime': return v ? isoToZoneInput(v) : '';
      default: return v == null ? '' : String(v);
    }
  }
  const readRaw = (el) => (el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value);
  function writeRaw(el, raw) { if (el.type === 'checkbox') el.checked = raw === 'true'; else el.value = raw; }

  function parseValue(type, raw) {
    const t = String(raw).trim();
    switch (type) {
      case 'int':
        if (!/^-?\d+$/.test(t)) return { error: 'Enter a whole number' };
        return { value: Number(t) };
      case 'number': {
        const n = Number(t);
        if (t === '' || !Number.isFinite(n)) return { error: 'Enter a number' };
        return { value: n };
      }
      case 'bool': return { value: raw === 'true' };
      case 'list': return { value: t.split(',').map((x) => x.trim()).filter(Boolean) };
      case 'countries': return { value: t.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean) };
      case 'datetime': return zoneInputToIso(t);
      default: return { value: t };
    }
  }

  const fieldEls = (form) => $$('[data-key]', form);
  const fieldWrap = (el) => el.closest('.field');
  const isDirty = (el) => el.dataset.base !== undefined && readRaw(el) !== el.dataset.base;

  /** Update inputs from server settings without touching fields the user is editing. */
  function renderForm(form, set, force) {
    for (const el of fieldEls(form)) {
      const key = el.dataset.key;
      if (!(key in set)) continue;
      const serverRaw = formatValue(el.dataset.type, set[key]);
      const cur = readRaw(el);
      if (force) { writeRaw(el, serverRaw); el.dataset.base = serverRaw; continue; }
      if (isDirty(el)) { if (cur === serverRaw) el.dataset.base = serverRaw; continue; }
      if (document.activeElement === el && el.dataset.base !== undefined) continue;
      if (cur !== serverRaw) writeRaw(el, serverRaw);
      el.dataset.base = serverRaw;
    }
    updateDirty(form);
  }

  function updateDirty(form) {
    let n = 0;
    for (const el of fieldEls(form)) {
      const d = !el.disabled && isDirty(el);
      if (d) n++;
      const w = fieldWrap(el);
      if (w) w.classList.toggle('is-dirty', d);
    }
    if (form.id === 'settings-form') {
      $('#settings-save').disabled = n === 0;
      $('#settings-discard').disabled = n === 0;
      $('#settings-dirty').textContent = n ? `${n} unsaved change${n === 1 ? '' : 's'}` : '';
    }
    return n;
  }

  function fieldBox(key) {
    try { return $(`.field[data-field="${CSS.escape(key)}"]`); } catch (e) { return null; }
  }
  function setFieldError(key, msg) {
    const w = key ? fieldBox(key) : null;
    if (!w) return false;
    const e = $('.field-error', w);
    w.classList.add('has-error');
    if (e) { e.textContent = msg; e.hidden = false; }
    const input = $('[data-key]', w);
    if (input) { input.setAttribute('aria-invalid', 'true'); if (!input.disabled) input.focus(); }
    w.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return true;
  }
  function clearFieldErrors(form) {
    for (const w of $$('.field.has-error', form)) {
      w.classList.remove('has-error');
      const e = $('.field-error', w);
      if (e) { e.textContent = ''; e.hidden = true; }
      const input = $('[data-key]', w);
      if (input) input.removeAttribute('aria-invalid');
    }
  }

  /** Changed fields only, parsed. Returns {changes, ok}. */
  function collectChanges(form) {
    const set = (state.status && state.status.settings) || {};
    const changes = {};
    let ok = true;
    let firstBad = null;
    for (const el of fieldEls(form)) {
      if (el.disabled || !isDirty(el)) continue;
      const key = el.dataset.key;
      const r = parseValue(el.dataset.type, readRaw(el));
      if (r.error) { ok = false; if (!firstBad) firstBad = key; setFieldError(key, r.error); continue; }
      if (!deepEqual(r.value, set[key])) changes[key] = r.value;
    }
    if (firstBad) { const w = fieldBox(firstBad); if (w) w.scrollIntoView({ block: 'nearest' }); }
    return { changes, ok };
  }

  function problemsList(problems) {
    return h('ul', null, (problems || []).map((p) => h('li', null, typeof p === 'string' ? p : (p.message || p.name || JSON.stringify(p)))));
  }

  /**
   * PATCH /api/settings and handle every documented response.
   * ctx: {form, errorBox, warningsBox, onSetupIncomplete(problems)}
   */
  async function patchSettings(changes, ctx) {
    const c = ctx || {};
    try {
      const res = await api('PATCH', '/api/settings', changes);
      if (state.status && res && res.settings) {
        state.status.settings = res.settings;
        for (const form of $$('form')) {
          for (const el of fieldEls(form)) {
            if (el.dataset.key in changes) { const raw = formatValue(el.dataset.type, res.settings[el.dataset.key]); writeRaw(el, raw); el.dataset.base = raw; }
          }
        }
        renderStatus();
      }
      const warnings = (res && res.warnings) || [];
      if (c.warningsBox) {
        clear(c.warningsBox);
        if (warnings.length) {
          c.warningsBox.append(h('div', { class: 'alert-title' }, 'Saved, with warnings'), h('ul', null, warnings.map((w) => h('li', null, w))));
          c.warningsBox.hidden = false;
        } else c.warningsBox.hidden = true;
      }
      for (const w of warnings) toast(w, 'warn', 9000);
      refreshNow();
      return res;
    } catch (err) {
      const d = err.data || {};
      if (err.status === 401) return null;
      if (d.error === 'setup_incomplete') {
        if (c.onSetupIncomplete) c.onSetupIncomplete(d.problems || []);
        else toast('Setup is incomplete, so Live was refused. See the setup alert.', 'error');
        if (state.status) { state.status.setup = { ok: false, checkedAt: new Date(serverNow()).toISOString(), problems: d.problems || [] }; renderSetupAlert(state.status); }
      } else if (d.error === 'locked_while_live') {
        if (!setFieldError(d.field, "Locked while Live. Switch to Shadow or Off to change it.")) toast(errorMessage(err), 'error');
        else toast(errorMessage(err), 'error');
      } else if (d.error === 'invalid') {
        if (!setFieldError(d.field, d.message || 'Invalid value')) {
          if (c.errorBox) { clear(c.errorBox).append(errorMessage(err)); c.errorBox.hidden = false; }
        }
        toast(errorMessage(err), 'error');
      } else {
        if (c.errorBox) { clear(c.errorBox).append(errorMessage(err)); c.errorBox.hidden = false; }
        toast(errorMessage(err), 'error');
      }
      return null;
    }
  }

  // ---------------------------------------------------------------- settings panel

  function renderSettings(st) {
    const set = st.settings || {};
    const form = $('#settings-form');
    const locked = set.mode === 'live';
    const lockedKeys = st.lockedWhileLive || [];
    for (const el of $$('[data-key]')) {
      const isLocked = locked && lockedKeys.includes(el.dataset.key);
      if (isLocked && !el.disabled && isDirty(el)) {
        // Field just became locked: drop the local edit, it can't be saved now.
        const raw = formatValue(el.dataset.type, set[el.dataset.key]);
        writeRaw(el, raw); el.dataset.base = raw;
      }
      el.disabled = isLocked;
      el.title = isLocked ? 'Locked while Live' : '';
      const w = fieldWrap(el);
      if (w) w.classList.toggle('is-locked', isLocked);
    }
    $('#lock-note').hidden = !(locked && lockedKeys.length);
    renderForm(form, set);
    updateTzHints();
  }

  function updateTzHints() {
    for (const el of $$('[data-type="datetime"]')) {
      const hint = $('.tz-hint', fieldWrap(el));
      if (!hint) continue;
      const r = zoneInputToIso(el.value);
      if (r.error) { hint.textContent = el.value ? r.error : ''; continue; }
      const ms = Date.parse(r.value);
      const o = otherZone(zone);
      let t = `= ${fmtDay('UTC', ms)} ${fmtHM('UTC', ms)} UTC · ${fmtHM(o.tz, ms)} ${o.label}`;
      if (localDiffers()) t += ` · ${fmtDay(null, ms)} ${fmtHM(null, ms)} your computer`;
      hint.textContent = t;
    }
  }

  async function onSettingsSubmit(e) {
    e.preventDefault();
    const form = $('#settings-form');
    clearFieldErrors(form);
    $('#settings-error').hidden = true;
    const { changes, ok } = collectChanges(form);
    if (!ok) { toast('Fix the highlighted fields first.', 'error'); return; }
    const keys = Object.keys(changes);
    if (!keys.length) { renderForm(form, state.status.settings, true); toast('Nothing to save; the values match the server.', 'info'); return; }
    if (changes.startsAt && changes.endsAt === undefined && Date.parse(changes.startsAt) >= Date.parse(state.status.settings.endsAt)) { setFieldError('startsAt', 'Start must be before the end.'); return; }
    if (changes.endsAt && Date.parse(changes.endsAt) <= Date.parse(changes.startsAt || state.status.settings.startsAt)) { setFieldError('endsAt', 'End must be after the start.'); return; }
    await withBusy($('#settings-save'), async () => {
      const res = await patchSettings(changes, { form, errorBox: $('#settings-error'), warningsBox: $('#settings-warnings') });
      if (res) toast(`Saved ${keys.length} setting${keys.length === 1 ? '' : 's'}.`, 'ok');
    });
    updateDirty(form);
  }

  function discardSettings() {
    const form = $('#settings-form');
    clearFieldErrors(form);
    $('#settings-error').hidden = true;
    renderForm(form, state.status.settings, true);
    updateTzHints();
  }

  // ---------------------------------------------------------------- pacing actions

  async function onNSubmit(e) {
    e.preventDefault();
    const form = $('#n-form');
    clearFieldErrors(form);
    const r = parseValue('int', $('#set-oneInN').value);
    if (r.error || r.value < 1) { setFieldError('oneInN', 'Enter a whole number, 1 or more'); return; }
    if (r.value === state.status.settings.oneInN) { toast(`N is already 1 in ${r.value}.`); return; }
    await withBusy($('#n-save'), async () => {
      const res = await patchSettings({ oneInN: r.value }, { form });
      if (res) toast(`Odds set to 1 in ${r.value} (${fmtPct(100 / r.value)}).`, 'ok');
    });
    updateDirty(form);
  }

  // ---------------------------------------------------------------- mode switch

  async function onModeClick(e) {
    const btn = e.target.closest('.mode-btn');
    if (!btn || !state.status) return;
    const mode = btn.dataset.mode;
    if (state.status.settings.mode === mode) return;
    if (mode === 'live') { openLiveConfirm(btn); return; }
    const group = $$('.mode-btn');
    group.forEach((b) => { b.disabled = true; });
    try {
      await withBusy(btn, async () => {
        const res = await patchSettings({ mode });
        if (res) toast(`Mode is now ${mode === 'off' ? 'Off' : 'Shadow'}.`, 'ok');
      });
    } finally {
      group.forEach((b) => { b.disabled = false; });
    }
  }

  function openLiveConfirm() {
    const st = state.status;
    const set = st.settings;
    const wt = windowTimes();
    const p = st.pacing || {};
    const nowMs = serverNow();
    const wstate = wt ? (nowMs < wt.startsAt ? 'not started' : nowMs < wt.endsAt ? 'open' : 'ended') : '–';
    const summary = h('dl', { class: 'summary-list' },
      h('dt', null, 'Odds'), h('dd', null, `1 in ${fmtInt(set.oneInN)} (${fmtPct(100 / set.oneInN)})`),
      h('dt', null, 'Cap'), h('dd', null, `${fmtInt(set.cap)} trays (${fmtInt((st.counts.live && st.counts.live.won) || 0)} given so far)`),
      h('dt', null, `Window (${zone.label})`), h('dd', null, wt ? rangeText(zone.tz, wt.startsAt, wt.endsAt, zone.label) : '–'),
      h('dt', null, 'Window (UTC)'), h('dd', null, wt ? rangeText('UTC', wt.startsAt, wt.endsAt, 'UTC') : '–'),
      h('dt', null, 'Window now'), h('dd', null, wstate),
      h('dt', null, 'Tray SKU'), h('dd', null, set.traySku || '–'),
      h('dt', null, 'Tag'), h('dd', null, set.tag || '–'),
      p.projectedWinners != null ? [h('dt', null, 'Projected'), h('dd', null, `≈ ${fmtInt(p.projectedWinners)} winners`)] : null);
    const warns = [];
    if (st.setup && st.setup.ok === false) warns.push(h('div', { class: 'alert alert-warn' }, h('div', { class: 'alert-title' }, 'The last setup check failed. The server will probably refuse Live:'), problemsList(st.setup.problems)));
    if (wstate === 'ended') warns.push(h('div', { class: 'alert alert-warn' }, 'The window has ended, so no orders will qualify.'));
    const body = [
      h('p', null, 'Live mode adds the tray to real customer orders at £0 and tags the order and customer in Shopify. Check these values:'),
      summary, warns,
    ];
    openModal({
      title: 'Switch the giveaway to Live?',
      className: 'modal-live',
      body,
      initialFocus: '.btn-secondary',
      actions: [
        { id: 'cancel', label: 'Cancel', class: 'btn-secondary' },
        {
          id: 'go', label: 'Go Live', class: 'btn-live',
          onClick: async (ctl) => {
            const res = await patchSettings({ mode: 'live' }, {
              onSetupIncomplete: (problems) => ctl.setError([h('div', { class: 'alert-title' }, 'Live was refused: setup is incomplete.'), problemsList(problems), h('p', { class: 'small' }, 'Fix these in the Setup panel, then try again.')]),
              errorBox: null,
            });
            if (!res) {
              if (!ctl.dialog.querySelector('.alert-error:not([hidden])')) ctl.setError('Could not switch to Live. See the message for details.');
              return false;
            }
            toast('The giveaway is LIVE.', 'ok');
            return true;
          },
        },
      ],
    });
  }

  // ================================================================ chart

  let chartHover = -1;
  let chartGeom = null;

  async function refreshTimeline() {
    try {
      const chart = $('#chart');
      chart.classList.add('is-loading');
      state.timeline = await api('GET', '/api/timeline?bucketMinutes=15');
      chart.classList.remove('is-loading');
      renderChart();
    } catch (e) {
      $('#chart').classList.remove('is-loading');
    }
  }

  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
  }

  function topRoundedBar(x, y, w, hgt, r) {
    const rr = Math.max(0, Math.min(r, w / 2, hgt));
    return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
  }

  function renderChart() {
    const tl = state.timeline;
    const box = $('#chart');
    if (!tl || !tl.window) return;
    const W = Math.max(300, Math.floor(box.clientWidth || 640));
    const s0 = Date.parse(tl.window.startsAt);
    const e0 = Date.parse(tl.window.endsAt);
    if (!(e0 > s0)) { clear(box).append(h('div', { class: 'chart-empty' }, 'Window is not set.')); return; }
    const bms = (tl.bucketMinutes || 15) * 60000;
    const nowMs = serverNow();
    const cap = Number(tl.cap) || 0;
    const buckets = (tl.buckets || []).map((b) => {
      const t0 = Date.parse(b.start);
      return { start: t0, end: Math.min(t0 + bms, e0), eligible: b.eligible || 0, winners: b.winners || 0, cum: b.cumulativeWinners || 0, ideal: b.idealCumulative };
    }).filter((b) => !Number.isNaN(b.start));

    const narrow = W < 520;
    const M = { l: 40, r: narrow ? 44 : 64, t: 18 };
    const topH = narrow ? 150 : 180;
    const gap = 30;
    const botH = narrow ? 56 : 66;
    const y2 = M.t + topH + gap;
    const H = y2 + botH + 26;
    const plotW = W - M.l - M.r;
    const x = (t) => M.l + ((t - s0) / (e0 - s0)) * plotW;

    const maxCum = buckets.reduce((m, b) => Math.max(m, b.cum, b.ideal || 0), 0);
    const step1 = niceStep(Math.max(cap, maxCum, 4) / 4);
    const yMax1 = Math.ceil((Math.max(cap, maxCum, 4) * 1.04) / step1) * step1;
    const y1 = (v) => M.t + topH - (v / yMax1) * topH;
    const maxElig = buckets.reduce((m, b) => Math.max(m, b.eligible), 0);
    const step2 = niceStep(Math.max(maxElig, 2) / 2);
    const yMax2 = Math.ceil(Math.max(maxElig, 2) / step2) * step2;
    const yb = (v) => y2 + botH - (v / yMax2) * botH;

    const svgEl = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', focusable: 'false' });

    // grid + y labels (top)
    const grid = s('g', { class: 'grid' });
    for (let v = 0; v <= yMax1 + 1e-9; v += step1) {
      grid.append(s('line', { x1: M.l, x2: M.l + plotW, y1: y1(v), y2: y1(v) }));
      svgEl.append(s('text', { class: 'axis-text', x: M.l - 6, y: y1(v) + 4, 'text-anchor': 'end' }, fmtInt(v)));
    }
    for (let v = 0; v <= yMax2 + 1e-9; v += step2) {
      grid.append(s('line', { x1: M.l, x2: M.l + plotW, y1: yb(v), y2: yb(v) }));
      if (v > 0) svgEl.append(s('text', { class: 'axis-text', x: M.l - 6, y: yb(v) + 4, 'text-anchor': 'end' }, fmtInt(v)));
    }
    svgEl.insertBefore(grid, svgEl.firstChild);
    svgEl.append(s('text', { class: 'panel-label', x: M.l, y: M.t - 6 }, 'Winners (cumulative)'));
    svgEl.append(s('text', { class: 'panel-label', x: M.l, y: y2 - 6 }, `Eligible orders per ${tl.bucketMinutes || 15} min`));

    // x ticks on IST whole hours
    const hourStep = plotW < 380 ? 3 : plotW < 700 ? 2 : 1;
    const zoneOffset = tzOffsetMs(zone.tz, s0);
    let t = Math.ceil((s0 + zoneOffset) / 3600000) * 3600000 - zoneOffset;
    for (; t <= e0; t += 3600000) {
      const hr = partsIn(zone.tz, t).hour;
      if (hr % hourStep !== 0) continue;
      const xx = x(t);
      svgEl.append(s('text', { class: 'axis-text', x: xx, y: y2 + botH + 16, 'text-anchor': 'middle' }, fmtHM(zone.tz, t)));
    }
    svgEl.append(s('line', { class: 'baseline', x1: M.l, x2: M.l + plotW, y1: y1(0), y2: y1(0) }));
    svgEl.append(s('line', { class: 'baseline', x1: M.l, x2: M.l + plotW, y1: yb(0), y2: yb(0) }));

    // bars
    const barEls = [];
    for (const b of buckets) {
      const bx = x(b.start) + 1;
      const bw = Math.max(1, x(b.end) - x(b.start) - 2);
      const top = yb(b.eligible);
      const p = s('path', { class: 'bar', d: topRoundedBar(bx, top, bw, yb(0) - top, 3) });
      if (b.eligible === 0) p.setAttribute('d', '');
      svgEl.append(p);
      barEls.push(p);
    }

    // cap line
    if (cap > 0) {
      svgEl.append(s('line', { class: 'line-cap', x1: M.l, x2: M.l + plotW, y1: y1(cap), y2: y1(cap) }));
      svgEl.append(s('text', { class: 'label-cap', x: M.l + plotW + 6, y: y1(cap) + 4 }, `Cap ${fmtInt(cap)}`));
    }

    // ideal line
    const idealPts = [[s0, 0]];
    for (const b of buckets) if (b.ideal != null) idealPts.push([b.end, b.ideal]);
    if (!buckets.length || buckets[buckets.length - 1].end < e0) idealPts.push([e0, cap]);
    svgEl.append(s('polyline', { class: 'line-ideal', points: idealPts.map((q) => `${x(q[0]).toFixed(1)},${y1(q[1]).toFixed(1)}`).join(' ') }));

    // winners line + area
    const winPts = [[s0, 0]];
    for (const b of buckets) { if (b.start > nowMs) break; winPts.push([Math.min(b.end, Math.max(b.start, nowMs)), b.cum]); }
    if (winPts.length > 1) {
      const pts = winPts.map((q) => `${x(q[0]).toFixed(1)},${y1(q[1]).toFixed(1)}`);
      const last = winPts[winPts.length - 1];
      svgEl.append(s('path', { class: 'area-win', d: `M${pts.join('L')}L${x(last[0]).toFixed(1)},${y1(0)}L${x(s0).toFixed(1)},${y1(0)}Z` }));
      svgEl.append(s('polyline', { class: 'line-win', points: pts.join(' ') }));
      const lx = x(last[0]), ly = y1(last[1]);
      svgEl.append(s('circle', { class: 'dot-win', cx: lx, cy: ly, r: 4.5 }));
      const right = lx + 8 + 30 < W;
      svgEl.append(s('text', { class: 'label-win', x: right ? lx + 8 : lx - 8, y: ly - 8, 'text-anchor': right ? 'start' : 'end' }, fmtInt(last[1])));
    } else {
      svgEl.append(s('text', { class: 'axis-text', x: M.l + plotW / 2, y: M.t + topH / 2, 'text-anchor': 'middle' },
        nowMs < s0 ? `No data yet. The window opens ${fmtDay(zone.tz, s0)} ${fmtHM(zone.tz, s0)} ${zone.label}.` : 'No data yet.'));
    }

    // now marker
    if (nowMs >= s0 && nowMs <= e0) {
      const nx = x(nowMs);
      svgEl.append(s('line', { class: 'now-line', x1: nx, x2: nx, y1: M.t, y2: yb(0) }));
      svgEl.append(s('text', { class: 'now-text', x: nx, y: M.t - 6, 'text-anchor': nx > W - 60 ? 'end' : 'middle' }, 'now'));
    }

    // hover layer
    const cross = s('line', { class: 'crosshair', x1: 0, x2: 0, y1: M.t, y2: yb(0), visibility: 'hidden' });
    svgEl.append(cross);
    const hit = s('rect', { class: 'hit', x: M.l, y: M.t, width: plotW, height: yb(0) - M.t });
    svgEl.append(hit);
    chartGeom = { buckets, x, cross, barEls, W, M, plotW, svgEl };
    if (chartHover >= buckets.length) chartHover = -1;

    const pick = (clientX) => {
      const rect = svgEl.getBoundingClientRect();
      const px = clientX - rect.left;
      let best = -1, bestD = Infinity;
      buckets.forEach((b, i) => { const d = Math.abs(x((b.start + b.end) / 2) - px); if (d < bestD) { bestD = d; best = i; } });
      return best;
    };
    hit.addEventListener('pointermove', (ev) => showChartTip(pick(ev.clientX)));
    hit.addEventListener('pointerdown', (ev) => showChartTip(pick(ev.clientX)));
    hit.addEventListener('pointerleave', () => { if (document.activeElement !== box) hideChartTip(); });

    const lastB = buckets[buckets.length - 1];
    box.setAttribute('aria-label', lastB
      ? `Winners chart: ${fmtInt(lastB.cum)} winners so far against an ideal of ${lastB.ideal == null ? 'unknown' : fmtInt(lastB.ideal)}; cap ${fmtInt(cap)}. Use the left and right arrow keys for each ${tl.bucketMinutes || 15}-minute bucket, or open "Show chart data".`
      : `Winners chart: no data yet; cap ${fmtInt(cap)}.`);
    clear(box).append(svgEl);
    if (chartHover >= 0 && !$('#chart-tip').hidden) showChartTip(chartHover);
    $('#chart-mode').textContent = state.status && state.status.activeMode === 'shadow' ? '(shadow)' : '(live)';
    renderChartTable(buckets);
  }

  function showChartTip(i) {
    const g = chartGeom;
    if (!g || i < 0 || !g.buckets[i]) return;
    chartHover = i;
    const b = g.buckets[i];
    const cx = g.x((b.start + b.end) / 2);
    g.cross.setAttribute('x1', cx); g.cross.setAttribute('x2', cx); g.cross.setAttribute('visibility', 'visible');
    g.barEls.forEach((el, j) => el.classList.toggle('is-hover', j === i));
    const tip = $('#chart-tip');
    const row = (keyCls, label, val) => h('div', { class: 'tip-row' },
      h('span', null, keyCls ? h('span', { class: `key ${keyCls}`, 'aria-hidden': 'true' }) : null, label), h('strong', null, val));
    clear(tip).append(
      h('div', { class: 'tip-title' }, `${fmtHM(zone.tz, b.start)}–${fmtHM(zone.tz, b.end)} ${zone.label}`),
      h('div', { class: 'small muted' }, `${fmtHM('UTC', b.start)}–${fmtHM('UTC', b.end)} UTC`),
      row('key-line key-win', 'Winners so far', fmtInt(b.cum)),
      row('key-line key-ideal', 'Ideal', b.ideal == null ? '–' : fmtInt(b.ideal)),
      row(null, 'Won in bucket', fmtInt(b.winners)),
      row('key-bar', 'Eligible in bucket', fmtInt(b.eligible)));
    tip.hidden = false;
    const wrap = $('.chart-wrap');
    const chart = $('#chart');
    const tw = tip.offsetWidth;
    let left = cx + 14;
    if (left + tw > wrap.clientWidth) left = cx - tw - 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${chart.offsetTop + 22}px`;
  }
  function hideChartTip() {
    const g = chartGeom;
    $('#chart-tip').hidden = true;
    chartHover = -1;
    if (g) { g.cross.setAttribute('visibility', 'hidden'); g.barEls.forEach((el) => el.classList.remove('is-hover')); }
  }

  function renderChartTable(buckets) {
    const body = clear($('#chart-table'));
    if (!buckets.length) { body.append(h('tr', null, h('td', { colspan: 5, class: 'muted' }, 'No buckets yet.'))); return; }
    for (const b of buckets.slice().reverse()) {
      body.append(h('tr', null,
        h('td', null, `${fmtHM(zone.tz, b.start)}–${fmtHM(zone.tz, b.end)}`),
        h('td', { class: 'num' }, fmtInt(b.eligible)),
        h('td', { class: 'num' }, fmtInt(b.winners)),
        h('td', { class: 'num' }, fmtInt(b.cum)),
        h('td', { class: 'num' }, b.ideal == null ? '–' : fmtInt(b.ideal))));
    }
  }

  // ================================================================ winners

  async function refreshWinners() {
    const mode = state.winnersMode;
    try {
      const res = await api('GET', `/api/winners${qs({ mode })}`);
      if (mode !== state.winnersMode) return;
      state.winners = (res && res.items) || [];
      renderWinners();
    } catch (e) { /* conn state shows problems */ }
  }

  function timeCell(iso) {
    const ms = Date.parse(iso);
    if (!iso || Number.isNaN(ms)) return h('td', null, '–');
    const label = sameDay(zone.tz, ms, serverNow()) ? fmtHMS(zone.tz, ms) : `${fmtDay(zone.tz, ms)} ${fmtHM(zone.tz, ms)}`;
    return h('td', { title: fullStamp(ms) }, h('time', { datetime: iso }, label));
  }

  function orderLink(o) {
    const url = safeUrl(o.adminUrl) || (state.status && safeUrl(state.status.shopify && state.status.shopify.adminOrdersUrl) && o.id ? state.status.shopify.adminOrdersUrl + encodeURIComponent(o.id) : null);
    const name = o.name || (o.number != null ? `#${o.number}` : o.id) || '–';
    return url ? h('a', { class: 'order-link', href: url, target: '_blank', rel: 'noopener noreferrer', title: `Open ${name} in Shopify admin (new tab)` }, name) : h('span', { class: 'order-link' }, name);
  }

  function tagBadge(st2) {
    if (!st2) return h('span', { class: 'muted' }, '–');
    return h('span', { class: `badge badge-${st2 === 'ok' ? 'ok' : st2 === 'failed' ? 'failed' : 'pending'}` }, st2 === 'ok' ? 'Tagged' : st2 === 'failed' ? 'Failed' : 'Pending');
  }

  function renderWinners() {
    const q = $('#winners-search').value.trim().toLowerCase().replace(/^#/, '');
    const sig = JSON.stringify([state.winnersMode, q, state.winners]);
    if (sig === state.winnersSig) return;
    state.winnersSig = sig;
    const items = q ? state.winners.filter((o) =>
      String(o.name || '').toLowerCase().replace(/^#/, '').includes(q) ||
      String(o.id || '').includes(q) ||
      String(o.customerEmail || '').toLowerCase().includes(q) ||
      String(o.slot) === q) : state.winners;
    $('#winners-count').textContent = q ? `${fmtInt(items.length)} of ${fmtInt(state.winners.length)}` : fmtInt(state.winners.length);
    const body = clear($('#winners-body'));
    for (const o of items) {
      const tags = h('td', null, h('div', { class: 'cell-actions' }, tagBadge(o.tagStatus),
        o.tagStatus === 'failed' ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { action: 'retry-tags', id: o.id, name: o.name || o.id } }, 'Retry tags') : null));
      body.append(h('tr', null,
        h('td', { class: 'num' }, o.slot == null ? '–' : fmtInt(o.slot)),
        h('td', null, orderLink(o)),
        timeCell(o.trayAddedAt || o.updatedAt),
        h('td', null, o.customerEmail || h('span', { class: 'muted' }, '–')),
        h('td', { class: 'num' }, fmtMoney(o.subtotal, o.currency)),
        tags));
    }
    const empty = $('#winners-empty');
    empty.hidden = items.length > 0;
    empty.textContent = q ? 'No winners match your search.' : state.winnersMode === 'shadow' ? 'No shadow winners yet.' : 'No winners yet.';
  }

  function setWinnersMode(mode) {
    state.winnersMode = mode;
    for (const b of $$('[data-wmode]')) b.setAttribute('aria-pressed', String(b.dataset.wmode === mode));
    $('#winners-csv').setAttribute('href', `/api/winners.csv${qs({ mode })}`);
    state.winners = [];
    state.winnersSig = '';
    renderWinners();
    refreshWinners();
  }

  // ================================================================ orders

  async function refreshOrders() {
    const o = state.orders;
    const seq = ++o.seq;
    try {
      const res = await api('GET', `/api/orders${qs({ status: o.status, mode: o.mode, q: o.q, limit: o.limit, offset: o.offset })}`);
      if (seq !== o.seq) return; // a newer request is in flight
      o.total = res.total || 0;
      o.items = res.items || [];
      if (o.offset > 0 && o.offset >= o.total) {
        o.offset = Math.max(0, Math.floor((o.total - 1) / o.limit) * o.limit);
        return refreshOrders();
      }
      renderOrders();
    } catch (e) { /* conn state shows problems */ }
    return undefined;
  }

  function renderOrders() {
    const o = state.orders;
    const sig = JSON.stringify([o.total, o.offset, o.items]);
    if (sig === o.sig) return;
    o.sig = sig;
    const body = clear($('#orders-body'));
    for (const r of o.items) {
      const canRetry = r.status === 'failed' || r.status === 'skipped';
      body.append(h('tr', null,
        h('td', null, orderLink(r), r.source === 'backfill' ? h('span', { class: 'muted small', title: 'Found by backfill, not the webhook' }, ' · backfill') : null),
        timeCell(r.receivedAt || r.createdAt),
        h('td', { class: 'num' }, fmtMoney(r.subtotal, r.currency)),
        h('td', null, r.country || '–'),
        h('td', null, h('span', { class: `badge badge-${r.status}` }, STATUS_LABEL[r.status] || humanize(r.status))),
        h('td', null, r.mode ? h('span', { class: `badge badge-plain badge-${r.mode}` }, r.mode) : h('span', { class: 'muted' }, '–')),
        h('td', null, r.reason ? humanize(r.reason) : h('span', { class: 'muted' }, '–')),
        h('td', { class: 'num' }, r.slot == null ? '–' : fmtInt(r.slot)),
        h('td', { class: 'num', title: r.rollN ? `Rolled at 1 in ${r.rollN}` : null }, fmtInt(r.attempts || 0)),
        h('td', null, r.lastError ? h('span', { class: 'err-text', title: r.lastError }, r.lastError) : h('span', { class: 'muted' }, '–')),
        h('td', null, h('div', { class: 'cell-actions' },
          canRetry ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { action: 'retry', id: r.id, name: r.name || r.id } }, 'Retry') : null,
          r.status === 'won' && r.tagStatus === 'failed' ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { action: 'retry-tags', id: r.id, name: r.name || r.id } }, 'Retry tags') : null))));
    }
    $('#orders-empty').hidden = o.items.length > 0;
    $('#orders-count').textContent = fmtInt(o.total);
    const from = o.total ? o.offset + 1 : 0;
    const to = Math.min(o.total, o.offset + o.items.length);
    $('#orders-range').textContent = o.total ? `${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(o.total)}` : '';
    $('#orders-prev').disabled = o.offset <= 0;
    $('#orders-next').disabled = o.offset + o.limit >= o.total;
  }

  let searchTimer = null;
  function onOrdersFilter() {
    const o = state.orders;
    o.status = $('#orders-status').value;
    o.mode = $('#orders-mode').value;
    o.q = $('#orders-q').value.trim();
    o.offset = 0;
    refreshOrders();
  }

  async function onTableAction(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const name = btn.dataset.name || id;
    const action = btn.dataset.action;
    await withBusy(btn, async () => {
      try {
        await api('POST', `/api/orders/${encodeURIComponent(id)}/${action === 'retry' ? 'retry' : 'retry-tags'}`, {});
        toast(action === 'retry' ? `${name} re-queued.` : `Tag retry started for ${name}.`, 'ok');
        refreshNow();
      } catch (err) {
        if (err.status !== 401) toast(`${name}: ${errorMessage(err)}`, 'error');
      }
    });
  }

  // ================================================================ check order

  function checkIcon(ok) {
    return h('span', { class: 'check-icon', 'aria-hidden': 'true' },
      s('svg', { viewBox: '0 0 16 16' }, s('path', { d: ok ? 'M3.5 8.5l3 3 6-7' : 'M4.5 4.5l7 7M11.5 4.5l-7 7' })));
  }
  function checksList(checks) {
    return h('ul', { class: 'checks' }, (checks || []).map((c) => h('li', { class: `check ${c.ok ? 'check-ok' : 'check-fail'}` },
      checkIcon(c.ok),
      h('div', null,
        h('span', { class: 'visually-hidden' }, c.ok ? 'Pass: ' : 'Fail: '),
        h('div', { class: 'check-name' }, c.name),
        c.detail != null && c.detail !== '' ? h('div', { class: 'check-detail' }, String(c.detail)) : null))));
  }

  async function onCheckSubmit(e) {
    e.preventDefault();
    const val = $('#check-input').value.trim();
    const out = $('#check-result');
    if (!val) { clear(out).append(h('p', { class: 'form-error' }, 'Enter an order number like #38014, or an order id.')); $('#check-input').focus(); return; }
    await withBusy($('#check-submit'), async () => {
      try {
        const res = await api('POST', '/api/orders/check', { order: val });
        const ord = res.order || {};
        const head = h('div', { class: 'check-head' },
          h('div', null, orderLink(ord), ord.subtotal != null ? h('span', { class: 'muted small' }, ` · ${fmtMoney(ord.subtotal, ord.currency)}`) : null),
          h('span', { class: `verdict ${res.eligible ? 'verdict-ok' : 'verdict-no'}` }, res.eligible ? 'Eligible' : 'Not eligible'));
        const stored = res.stored
          ? h('div', { class: 'check-stored' }, 'Stored as',
            h('span', { class: `badge badge-${res.stored.status}` }, STATUS_LABEL[res.stored.status] || humanize(res.stored.status)),
            res.stored.mode ? h('span', { class: `badge badge-plain badge-${res.stored.mode}` }, res.stored.mode) : null,
            res.stored.reason ? h('span', { class: 'muted' }, humanize(res.stored.reason)) : null,
            res.stored.slot != null ? h('span', { class: 'muted' }, `slot ${res.stored.slot}`) : null)
          : h('div', { class: 'check-stored muted' }, 'Not stored by the app (no webhook received, or it did not qualify).');
        clear(out).append(head, checksList(res.checks), stored);
      } catch (err) {
        if (err.status === 401) return;
        clear(out).append(h('p', { class: 'form-error' }, err.status === 404 ? (err.data.message || `Order ${val} was not found.`) : errorMessage(err)));
      }
    });
  }

  // ================================================================ setup

  function renderSetupSummary(st) {
    const setup = st.setup || {};
    const el = clear($('#setup-summary'));
    const when = setup.checkedAt ? ` (checked ${fmtHM(zone.tz, Date.parse(setup.checkedAt))} ${zone.label})` : '';
    if (setup.ok === true) el.append(h('span', { class: 'ok-text' }, 'All checks passed'), when);
    else if (setup.ok === false) el.append(h('span', { class: 'bad-text' }, `${(setup.problems || []).length || 'Some'} problem${(setup.problems || []).length === 1 ? '' : 's'}`), when);
    else el.append(h('span', { class: 'muted' }, 'Not checked yet.'));
    if (!state.setupResult && setup.ok === false && (setup.problems || []).length) {
      clear($('#setup-checks')).append(...setup.problems.map((p) => h('li', { class: 'check check-fail' }, checkIcon(false),
        h('div', null, h('span', { class: 'visually-hidden' }, 'Fail: '), h('div', { class: 'check-name' }, typeof p === 'string' ? p : (p.message || p.name || ''))))));
    }
  }

  function renderSetupResult() {
    const r = state.setupResult;
    if (!r) return;
    clear($('#setup-checks')).append(...checksList(r.checks).childNodes);
    const wh = r.webhook || {};
    const wEl = clear($('#webhook-state'));
    if (wh.registered) wEl.append(h('span', { class: 'ok-text' }, 'Registered'), wh.uri ? h('div', { class: 'mono' }, wh.uri) : null);
    else wEl.append(h('span', { class: 'bad-text' }, 'Not registered'));
    $('#webhook-register').disabled = !!wh.registered;
    $('#webhook-register').textContent = wh.registered ? 'Registered' : 'Register webhook';
  }

  async function runSetup() {
    await withBusy($('#setup-run'), async () => {
      try {
        const r = await api('GET', '/api/setup');
        state.setupResult = r;
        if (state.status) {
          state.status.setup = { ok: r.ok, checkedAt: r.checkedAt, problems: (r.checks || []).filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ''}`) };
          renderSetupAlert(state.status);
          renderSetupSummary(state.status);
        }
        renderSetupResult();
        toast(r.ok ? 'Setup checks passed.' : 'Setup checks found problems.', r.ok ? 'ok' : 'warn');
      } catch (err) {
        if (err.status !== 401) toast(`Setup check failed: ${errorMessage(err)}`, 'error');
      }
    });
  }

  async function registerWebhook() {
    const btn = $('#webhook-register');
    await withBusy(btn, async () => {
      try {
        const r = await api('POST', '/api/setup/webhook', {});
        toast(r.created ? 'Webhook registered.' : 'Webhook was already registered.', 'ok');
      } catch (err) {
        if (err.status !== 401) toast(`Could not register the webhook: ${errorMessage(err)}`, 'error');
        return;
      }
    });
    await runSetup();
  }

  // ================================================================ system + danger

  function ago(iso) {
    const ms = Date.parse(iso);
    if (!iso || Number.isNaN(ms)) return 'never';
    const d = serverNow() - ms;
    if (d < 60000) return `${Math.max(0, Math.round(d / 1000))}s ago`;
    if (d < 3600000) return `${Math.round(d / 60000)} min ago`;
    return `${fmtDay(zone.tz, ms)} ${fmtHM(zone.tz, ms)} ${zone.label}`;
  }

  function renderSystem(st) {
    const w = st.worker || {};
    const b = st.backfill || {};
    const sh = st.shopify || {};
    const rows = [
      ['Worker', `${w.running ? 'Running' : 'Stopped'} · last tick ${ago(w.lastTickAt)}`],
      ['Queue', `${fmtInt(w.queued)} queued · ${fmtInt(w.awarding)} awarding · ${fmtInt(w.tagRetriesPending)} tag retries pending`],
      ['Backfill (safety net)', `On · last run ${ago(b.lastRunAt)}${b.lastFound ? ` · found ${b.lastFound}` : ''}`],
      b.lastError ? ['Backfill error', b.lastError] : null,
      ['Store', sh.store || '–'],
      ['Shopify API', `${sh.apiVersion || '–'} · ${sh.authMode === 'client_credentials' ? 'client credentials' : sh.authMode || '–'}`],
      ['Server time', `${fmtHMS(zone.tz, serverNow())} ${zone.label} · ${fmtHMS('UTC', serverNow())} UTC`],
    ].filter(Boolean);
    const dl = clear($('#system'));
    for (const [k, v] of rows) dl.append(h('dt', null, k), h('dd', { class: k === 'Backfill error' ? 'bad-text' : null }, v));
  }

  function renderDanger(st) {
    const live = st.settings.mode === 'live';
    $('#reset-all').disabled = live;
    $('#reset-all-note').textContent = live ? 'Not available while Live. Switch to Shadow or Off first.' : 'Deletes every stored order, live and shadow.';
  }

  function openReset(scope) {
    const input = h('input', { type: 'text', id: 'reset-confirm', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'reset-help' });
    const body = [
      h('p', null, scope === 'all'
        ? 'This deletes every stored order (live and shadow) and frees all winner slots. It cannot be undone.'
        : 'This deletes all shadow-mode orders and shadow winners. Live data is not touched. It cannot be undone.'),
      h('div', { class: 'field' }, h('label', { for: 'reset-confirm' }, 'Type RESET to confirm'), input,
        h('p', { id: 'reset-help', class: 'field-hint' }, 'Capital letters.')),
    ];
    let ctl = null;
    const doReset = async (c) => {
      try {
        const r = await api('POST', '/api/reset', { scope, confirm: input.value });
        toast(`Reset ${scope === 'all' ? 'all data' : 'shadow data'}: ${fmtInt(r.deleted)} deleted.`, 'ok');
        state.winnersSig = ''; state.orders.sig = '';
        refreshNow();
        return true;
      } catch (err) {
        if (err.status === 401) return true;
        c.setError(errorMessage(err));
        return false;
      }
    };
    ctl = openModal({
      title: scope === 'all' ? 'Reset all data?' : 'Reset shadow data?',
      className: 'modal-danger',
      body,
      initialFocus: '#reset-confirm',
      actions: [
        { id: 'cancel', label: 'Cancel', class: 'btn-secondary' },
        { id: 'go', label: scope === 'all' ? 'Delete all data' : 'Delete shadow data', class: 'btn-danger', disabled: true, onClick: doReset },
      ],
    });
    input.addEventListener('input', () => { ctl.buttons.go.disabled = input.value !== 'RESET'; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value === 'RESET') { e.preventDefault(); ctl.buttons.go.click(); } });
  }

  // ================================================================ events feed

  const EVENTS_LIMIT = 50;

  async function refreshEvents() {
    try {
      const res = await api('GET', `/api/events${qs({ limit: EVENTS_LIMIT })}`);
      const fresh = (res && res.items) || [];
      if (!state.eventsLoaded) {
        state.events = fresh;
        state.eventsDone = fresh.length < EVENTS_LIMIT;
        state.eventsLoaded = true;
        renderEvents(new Set());
        return;
      }
      const have = new Set(state.events.map((e) => String(e.id)));
      const added = fresh.filter((e) => !have.has(String(e.id)));
      if (!added.length) return;
      if (added.length === fresh.length && fresh.length >= EVENTS_LIMIT) {
        // Gap: more than a page arrived since the last poll. Start over from the newest page.
        state.events = fresh;
        state.eventsDone = false;
      } else {
        state.events = added.concat(state.events);
      }
      renderEvents(new Set(added.map((e) => String(e.id))));
    } catch (e) { /* conn state shows problems */ }
  }

  async function loadOlderEvents() {
    const last = state.events[state.events.length - 1];
    if (!last) return;
    await withBusy($('#feed-older'), async () => {
      try {
        const res = await api('GET', `/api/events${qs({ limit: EVENTS_LIMIT, before: last.id })}`);
        const items = (res && res.items) || [];
        const have = new Set(state.events.map((e) => String(e.id)));
        state.events = state.events.concat(items.filter((e) => !have.has(String(e.id))));
        state.eventsDone = items.length < EVENTS_LIMIT;
        renderEvents(new Set());
      } catch (err) {
        if (err.status !== 401) toast(`Could not load older events: ${errorMessage(err)}`, 'error');
      }
    });
  }

  function eventOrderLink(ev) {
    if (!ev.orderName && !ev.orderId) return null;
    const base = state.status && state.status.shopify && safeUrl(state.status.shopify.adminOrdersUrl);
    const label = ev.orderName || ev.orderId;
    return base && ev.orderId
      ? h('a', { href: base + encodeURIComponent(ev.orderId), target: '_blank', rel: 'noopener noreferrer' }, label)
      : h('span', null, label);
  }

  function renderEvents(newIds) {
    const sig = JSON.stringify([state.events.length, state.events[0] && state.events[0].id, state.eventsDone]);
    if (sig === state.eventsSig && !newIds.size) return;
    state.eventsSig = sig;
    const list = clear($('#feed'));
    for (const ev of state.events) {
      const ms = Date.parse(ev.at);
      const level = ev.level === 'error' || ev.level === 'warn' ? ev.level : 'info';
      const actor = ev.actor && ev.actor !== 'system' ? ev.actor : null;
      list.append(h('li', { class: `feed-item${newIds.has(String(ev.id)) ? ' is-new' : ''}`, dataset: { level } },
        h('span', { class: 'feed-level', 'aria-hidden': 'true' }),
        h('div', null,
          h('div', { class: 'feed-meta' },
            h('span', { class: 'visually-hidden' }, `${level}: `),
            Number.isNaN(ms) ? null : h('time', { datetime: ev.at, title: fullStamp(ms) }, sameDay(zone.tz, ms, serverNow()) ? fmtHMS(zone.tz, ms) : `${fmtDay(zone.tz, ms)} ${fmtHM(zone.tz, ms)}`),
            ev.type ? h('span', { class: 'feed-type' }, humanize(ev.type)) : null,
            eventOrderLink(ev),
            actor ? h('span', { class: 'feed-actor' }, `by ${actor}`) : null),
          h('div', { class: 'feed-msg' }, ev.message || ''))));
    }
    $('#feed-empty').hidden = state.events.length > 0;
    const older = $('#feed-older');
    older.hidden = state.events.length === 0;
    if (!older.classList.contains('is-busy')) older.disabled = state.eventsDone;
    older.textContent = state.eventsDone ? 'No older events' : 'Load older';
  }

  // ================================================================ time zone switch

  /** Labels that are static in the HTML: column titles, field labels, the note above the window fields. */
  function applyZoneLabels() {
    const o = otherZone(zone);
    for (const el of $$('.zl')) el.textContent = zone.label;
    const note = $('#tz-note');
    if (note) note.textContent = `Enter times in ${zone.name}. The UTC time and the ${o.label} time are shown under each field.`;
    for (const b of $$('.zone-btn')) b.setAttribute('aria-pressed', b.dataset.zone === zone.id ? 'true' : 'false');
  }

  /** Time fields the admin has typed but not saved keep meaning the same moment in the new zone. */
  function convertDatetimeInputs(fromTz, toTz) {
    for (const el of $$('[data-type="datetime"]')) {
      if (el.dataset.base !== undefined) el.dataset.base = convertInputZone(el.dataset.base, fromTz, toTz);
      el.value = convertInputZone(el.value, fromTz, toTz);
    }
  }

  function setZone(id) {
    const next = zoneById(id);
    if (next === zone) return;
    convertDatetimeInputs(zone.tz, next.tz);
    zone = next;
    storeZone(zone.id);
    applyZoneLabels();
    if (!state.me) return;
    // The tables skip a redraw when their data is unchanged; the times they show are not part of the data.
    state.winnersSig = '';
    state.orders.sig = '';
    state.eventsSig = '';
    renderStatus();
    renderChart();
    renderWinners();
    renderOrders();
    renderEvents(new Set());
    renderSetupResult();
    updateTzHints();
  }

  // ================================================================ init

  function updateThemeButton() {
    const btn = $('#theme-toggle');
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    btn.setAttribute('aria-label', `Switch to ${next} theme`);
    btn.title = `Switch to ${next} theme`;
  }

  function bind() {
    $('#login-form').addEventListener('submit', onLoginSubmit);
    $('#logout').addEventListener('click', logout);
    $('#theme-toggle').addEventListener('click', () => {
      const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      storeTheme(next);
      updateThemeButton();
    });
    if (mqDark && mqDark.addEventListener) mqDark.addEventListener('change', updateThemeButton);
    updateThemeButton();

    for (const b of $$('.zone-btn')) b.addEventListener('click', () => setZone(b.dataset.zone));
    applyZoneLabels();

    $('#mode-switch').addEventListener('click', onModeClick);

    for (const form of [$('#settings-form'), $('#n-form')]) {
      const onEdit = (e) => {
        const w = e.target.closest && e.target.closest('.field');
        if (w && w.classList.contains('has-error')) {
          w.classList.remove('has-error');
          const fe = $('.field-error', w); if (fe) { fe.hidden = true; fe.textContent = ''; }
          e.target.removeAttribute('aria-invalid');
        }
        updateDirty(form);
        if (e.target.dataset && e.target.dataset.type === 'datetime') updateTzHints();
        if (e.target.id === 'set-oneInN') updateNPreview();
      };
      form.addEventListener('input', onEdit);
      form.addEventListener('change', onEdit);
    }
    $('#settings-form').addEventListener('submit', onSettingsSubmit);
    $('#settings-discard').addEventListener('click', discardSettings);
    $('#n-form').addEventListener('submit', onNSubmit);

    for (const b of $$('[data-wmode]')) b.addEventListener('click', () => { if (b.dataset.wmode !== state.winnersMode) setWinnersMode(b.dataset.wmode); });
    $('#winners-search').addEventListener('input', renderWinners);
    $('#winners-body').addEventListener('click', onTableAction);
    $('#orders-body').addEventListener('click', onTableAction);
    $('#orders-status').addEventListener('change', onOrdersFilter);
    $('#orders-mode').addEventListener('change', onOrdersFilter);
    $('#orders-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(onOrdersFilter, 300); });
    $('#orders-prev').addEventListener('click', () => { const o = state.orders; o.offset = Math.max(0, o.offset - o.limit); refreshOrders(); });
    $('#orders-next').addEventListener('click', () => { const o = state.orders; if (o.offset + o.limit < o.total) { o.offset += o.limit; refreshOrders(); } });

    $('#check-form').addEventListener('submit', onCheckSubmit);
    $('#setup-run').addEventListener('click', runSetup);
    $('#webhook-register').addEventListener('click', registerWebhook);
    $('#reset-shadow').addEventListener('click', () => openReset('shadow'));
    $('#reset-all').addEventListener('click', () => { if (state.status && state.status.settings.mode !== 'live') openReset('all'); });
    $('#feed-older').addEventListener('click', loadOlderEvents);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPolling();
      else if (state.me) tick(true);
    });

    // Countdown + "x s ago" text tick every second (cheap, no network).
    setInterval(() => {
      if (!state.status || document.hidden) return;
      renderWindow();
      renderSystem(state.status);
    }, 1000);

    const chartBox = $('#chart');
    chartBox.addEventListener('focus', () => { const g = chartGeom; if (g && g.buckets.length) showChartTip(chartHover >= 0 ? chartHover : g.buckets.length - 1); });
    chartBox.addEventListener('blur', hideChartTip);
    chartBox.addEventListener('keydown', (ev) => {
      const g = chartGeom;
      if (!g || !g.buckets.length) return;
      const n = g.buckets.length;
      let i = chartHover < 0 ? n - 1 : chartHover;
      if (ev.key === 'ArrowLeft') i -= 1;
      else if (ev.key === 'ArrowRight') i += 1;
      else if (ev.key === 'Home') i = 0;
      else if (ev.key === 'End') i = n - 1;
      else if (ev.key === 'Escape') { hideChartTip(); return; }
      else return;
      ev.preventDefault();
      showChartTip(Math.max(0, Math.min(n - 1, i)));
    });

    // Redraw the chart when its width changes.
    if (window.ResizeObserver) {
      let lastW = 0, raf = 0;
      new ResizeObserver((entries) => {
        const w = Math.floor(entries[0].contentRect.width);
        if (Math.abs(w - lastW) < 2) return;
        lastW = w;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { hideChartTip(); renderChart(); });
      }).observe($('#chart'));
    }
  }

  async function boot() {
    bind();
    try {
      const me = await api('GET', '/api/me');
      if (me && me.name) showApp(me.name);
      else showLogin();
    } catch (e) {
      if (e.status === 401) { if ($('#login-view').hidden) showLogin(); }
      else showLogin(errorMessage(e));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
