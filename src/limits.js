'use strict';
// Plan limits (5h / weekly % used and reset times) for tracked Claude subscriptions.
// Asks Anthropic's usage endpoint with the login Claude Code already stored on this machine.
// The token is only sent to api.anthropic.com; only the window length, % used and reset time
// are shared with the pool.
//
// Every machine on a subscription can check, but they take turns: a machine skips its check
// while any machine's last check is still fresh. Checks run every minute while someone in the
// pool is working on the subscription and every 5 minutes otherwise. Every check is recorded,
// failed ones too, so the dashboard can say how old the numbers are and why.
const fs = require('fs');
const path = require('path');
const { currentSub } = require('./discover');
const { log } = require('./util');

const URL_USAGE = 'https://api.anthropic.com/api/oauth/usage';
const WINDOWS = { five_hour: 300, seven_day: 10080 };
const BUSY_MS = 60e3; // check interval while someone is working
const IDLE_MS = 5 * 60e3; // check interval otherwise
const ACTIVE_MS = 5 * 60e3; // usage this recent = someone is working
const TICK_MS = 5e3;
const MAX_BACKOFF_MS = 30 * 60e3;

function token(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth;
    // Expired: Claude Code refreshes it next time it runs; we never refresh it ourselves.
    return c && c.accessToken && (!c.expiresAt || c.expiresAt > Date.now()) ? c.accessToken : null;
  } catch { return null; } // macOS keeps it in the keychain: no limits there
}

// Turns the endpoint's answer into [{ m: window minutes, u: % used, r: reset ms }]. A plan without
// a window (no 5-hour limit) simply has no entry for it. A model's own weekly limit inside the
// weekly one (seven_day_<model>) becomes an entry of the same length with k: the model's name.
function parseUsage(j) {
  const out = [];
  const add = (w, m, k) => {
    // reset times jitter by a fraction of a second between calls; minute precision keeps one window one window
    const r = w && Math.round(Date.parse(w.resets_at) / 60e3) * 60e3;
    if (w && Number.isFinite(r) && typeof w.utilization === 'number') out.push({ m, u: Math.max(0, Math.min(100, Math.round(w.utilization))), r, ...(k ? { k } : {}) });
  };
  for (const [k, m] of Object.entries(WINDOWS)) add(j && j[k], m);
  for (const [k, w] of Object.entries(j || {})) { const model = /^seven_day_([a-z0-9]+)$/.exec(k); if (model && out.some((x) => x.m === WINDOWS.seven_day && !x.k)) add(w, WINDOWS.seven_day, model[1]); }
  return out;
}

class LimitError extends Error {
  constructor(code, msg, retryMs) { super(msg); this.code = code; this.retryMs = retryMs; }
}

function retryAfter(res) {
  const v = res.headers.get('retry-after');
  if (!v) return 0;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : 0;
}

// -> [{ m, u, r }] | null (no usable login here). Throws LimitError.
async function fetchLimits(dir) {
  const tok = token(dir);
  if (!tok) return null;
  let res;
  try {
    res = await fetch(URL_USAGE, { headers: { authorization: `Bearer ${tok}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'plainsight' }, signal: AbortSignal.timeout(15e3) });
  } catch (e) {
    throw new LimitError('net', e.name === 'TimeoutError' ? 'timed out' : 'network error');
  }
  if (res.status === 429) throw new LimitError('429', 'rate limited', retryAfter(res));
  if (res.status === 401 || res.status === 403) throw new LimitError('auth', `HTTP ${res.status}`);
  if (!res.ok) throw new LimitError(`http ${res.status}`, `HTTP ${res.status}`, retryAfter(res));
  return parseUsage(await res.json());
}

// Pure: when this machine should check next. seen: { act, chk } (last activity, last real check
// by any machine); back: { until } own backoff; jitter spreads machines apart so one goes first.
function nextCheck(seen, back, now, jitter) {
  const every = now - (seen.act || 0) < ACTIVE_MS ? BUSY_MS : IDLE_MS;
  return Math.max((seen.chk || 0) + every + jitter, back.until || 0);
}

function startLimits(cfg, store) {
  const seen = new Map(); // sub -> { act, chk }
  const back = new Map(); // sub -> { n, until }
  const noLogin = new Set();
  const jitter = Math.floor(Math.random() * 20e3);
  const note = (ev) => {
    if (!ev.sub || (ev.k !== 'u' && ev.k !== 'hb')) return;
    let s = seen.get(ev.sub);
    if (!s) { s = { act: 0, chk: 0 }; seen.set(ev.sub, s); }
    if (ev.k === 'u' || ev.turn === 1) { if (ev.t > s.act) s.act = ev.t; }
    // a missing login on one machine is not a check: it asked nobody
    else if (ev.p === 'claude' && (Array.isArray(ev.lim) || (typeof ev.le === 'string' && ev.le !== 'login'))) { if (ev.t > s.chk) s.chk = ev.t; }
  };
  for (const ev of store.all()) note(ev);
  store.on('change', ({ origin, count }) => { for (const ev of store.get(origin).slice(-count)) note(ev); });

  const record = (t, e) => store.appendLocal(cfg.nodeId, [{ k: 'hb', sub: t.sub, p: 'claude', ...e }]);
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      for (const t of cfg.tracked) {
        if (t.provider !== 'claude' || currentSub('claude', t.dir) !== t.sub) continue;
        const now = Date.now();
        const s = seen.get(t.sub) || { act: 0, chk: 0 };
        const b = back.get(t.sub) || { n: 0, until: 0 };
        if (now < nextCheck(s, b, now, jitter)) continue;
        try {
          const lim = await fetchLimits(t.dir);
          if (lim === null) {
            // tell the pool once, so the dashboard can say why this machine is not checking
            if (!noLogin.has(t.sub)) { noLogin.add(t.sub); log(`limits: ${t.label}: no valid Claude login here (Claude Code refreshes it next time it runs)`); record(t, { le: 'login' }); }
            continue;
          }
          if (noLogin.delete(t.sub)) log(`limits: ${t.label}: login is back`);
          if (!lim.length) continue;
          back.delete(t.sub);
          // k 'hb' on purpose: peers on older versions accept it and ignore the extra fields
          record(t, { lim });
        } catch (e) {
          const code = e instanceof LimitError ? e.code : 'error';
          const n = b.n + 1;
          // 429: 2, 4, 8, 16, 30 min; anything else: 1, 2, 4… min. A Retry-After wins if longer.
          const wait = Math.min(MAX_BACKOFF_MS, Math.max(e.retryMs || 0, (code === '429' ? 2 : 1) * 60e3 * 2 ** (n - 1)));
          back.set(t.sub, { n, until: Date.now() + wait });
          log(`limits: ${t.label}: ${e.message}; next try in ${Math.round(wait / 60e3)}m`);
          record(t, { le: code, ra: Date.now() + wait });
        }
      }
    } finally { busy = false; }
  }
  tick();
  return setInterval(tick, TICK_MS);
}

module.exports = { startLimits, parseUsage, nextCheck, BUSY_MS, IDLE_MS };
