'use strict';
// API-equivalent prices (USD per token). Source: LiteLLM's public price table, cached daily.
// Local overrides: ~/.plainsight/prices.json  { "model-name": { "input": 5e-6, "output": 25e-6, "cacheRead": 5e-7, "cacheWrite": 6.25e-6 } }
// Prices are applied at view time, so fixing a price fixes all history.
const { readJSON, writeJSON, paths, log } = require('./util');

const SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MAX_AGE = 24 * 3600e3;

let table = null;

function compact(raw) {
  const t = {};
  for (const [name, v] of Object.entries(raw || {})) {
    if (!v || typeof v.input_cost_per_token !== 'number') continue;
    t[name] = {
      input: v.input_cost_per_token,
      output: v.output_cost_per_token || 0,
      cacheRead: typeof v.cache_read_input_token_cost === 'number' ? v.cache_read_input_token_cost : null,
      cacheWrite: typeof v.cache_creation_input_token_cost === 'number' ? v.cache_creation_input_token_cost : null,
    };
  }
  return t;
}

async function refresh() {
  const cached = readJSON(paths.priceCache, null);
  if (cached && Date.now() - cached.at < MAX_AGE) return;
  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeJSON(paths.priceCache, { at: Date.now(), table: compact(await res.json()) });
    clearMemo();
  } catch (e) {
    log('price refresh failed (keeping cache):', e.message);
  }
}

function load() {
  if (table) return table;
  const cached = readJSON(paths.priceCache, { table: {} });
  table = { ...cached.table, ...readJSON(paths.prices, {}) };
  return table;
}

const memo = new Map();
function lookup(model) {
  if (memo.has(model)) return memo.get(model);
  const t = load();
  const base = model.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
  const tries = [model, base, `anthropic/${base}`, `openai/${base}`, `${base}-latest`];
  let p = null;
  for (const k of tries) if (t[k]) { p = t[k]; break; }
  if (p) {
    p = { ...p };
    const anthropic = /claude/i.test(model);
    if (p.cacheRead == null) p.cacheRead = p.input * 0.1;
    if (p.cacheWrite == null) p.cacheWrite = anthropic ? p.input * 1.25 : p.input;
  }
  memo.set(model, p);
  return p;
}

function clearMemo() { memo.clear(); table = null; }

// Cost of one usage event, split by type. null when the model has no known price.
function cost(ev) {
  const p = lookup(ev.m);
  if (!p) return null;
  return {
    input: (ev.in || 0) * p.input,
    cacheRead: (ev.cr || 0) * p.cacheRead,
    cacheWrite: (ev.cw || 0) * p.cacheWrite,
    output: (ev.out || 0) * p.output,
    savings: (ev.cr || 0) * (p.input - p.cacheRead),
  };
}

module.exports = { refresh, cost, lookup, clearMemo, SOURCE };
