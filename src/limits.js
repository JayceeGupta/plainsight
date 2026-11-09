'use strict';
// Plan limits (5h / weekly % used and reset times) for tracked Claude subscriptions.
// Asks Anthropic's usage endpoint with the login Claude Code already stored on this machine.
// The token is only sent to api.anthropic.com; only the window length, % used and reset time
// are shared with the pool.
const fs = require('fs');
const path = require('path');
const { currentSub } = require('./discover');
const { log } = require('./util');

const URL_USAGE = 'https://api.anthropic.com/api/oauth/usage';
const WINDOWS = { five_hour: 300, seven_day: 10080 };

function token(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth;
    // Expired: Claude Code refreshes it next time it runs; we never refresh it ourselves.
    return c && c.accessToken && (!c.expiresAt || c.expiresAt > Date.now()) ? c.accessToken : null;
  } catch { return null; } // macOS keeps it in the keychain: no limits there
}

// Turns the endpoint's answer into [{ m: window minutes, u: % used, r: reset ms }].
function parseUsage(j) {
  const out = [];
  for (const [k, m] of Object.entries(WINDOWS)) {
    const w = j && j[k];
    // reset times jitter by a fraction of a second between calls; minute precision keeps one window one window
    const r = w && Math.round(Date.parse(w.resets_at) / 60e3) * 60e3;
    if (w && Number.isFinite(r) && typeof w.utilization === 'number') out.push({ m, u: Math.max(0, Math.min(100, Math.round(w.utilization))), r });
  }
  return out;
}

async function fetchLimits(dir) {
  const tok = token(dir);
  if (!tok) return null;
  const res = await fetch(URL_USAGE, { headers: { authorization: `Bearer ${tok}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'plainsight' }, signal: AbortSignal.timeout(15e3) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseUsage(await res.json());
}

// Polls every tracked Claude dir; appends an event only when something changed (or hourly).
function startLimits(cfg, store) {
  const last = new Map();
  const warned = new Set();
  async function poll() {
    for (const t of cfg.tracked) {
      if (t.provider !== 'claude' || currentSub('claude', t.dir) !== t.sub) continue;
      try {
        const lim = await fetchLimits(t.dir);
        if (!lim || !lim.length) continue;
        const key = JSON.stringify(lim);
        const prev = last.get(t.sub);
        if (prev && prev.key === key && Date.now() - prev.t < 3600e3) continue;
        last.set(t.sub, { key, t: Date.now() });
        // k 'hb' on purpose: peers on older versions accept it and ignore the extra fields
        store.appendLocal(cfg.nodeId, [{ k: 'hb', sub: t.sub, p: 'claude', lim }]);
      } catch (e) {
        if (!warned.has(t.sub)) { warned.add(t.sub); log(`limits: ${t.label}: ${e.message}`); }
      }
    }
  }
  poll();
  return setInterval(poll, 5 * 60e3);
}

module.exports = { startLimits, parseUsage };
