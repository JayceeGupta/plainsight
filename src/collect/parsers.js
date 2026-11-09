'use strict';
// Pure parsers: transcript lines in, usage events out. Only numbers, model names and hashed ids leave here.
const { hash, subId } = require('../util');

// Claude Code: ~/.claude/projects/**/*.jsonl. One assistant message can span several lines
// (one per content block) that repeat the same usage; dedupe by message id + request id.
function parseClaude(lines, ctx) {
  const out = [];
  for (const line of lines) {
    // a typed prompt (not a tool result): rides on hb so older peers accept it
    if (line.startsWith('{"') && line.includes('"type":"user"') && !line.includes('"tool_result"')) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const t = Date.parse(o && o.timestamp);
      if (o && o.type === 'user' && o.message && o.message.role === 'user' && !o.isMeta && Number.isFinite(t)) {
        out.push({ k: 'hb', p: 'claude', t, id: hash(`cp:${o.uuid || line}`, 20), sid: hash(o.sessionId || 'none', 12), turn: 1 });
      }
      continue;
    }
    if (!line.includes('"usage"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const msg = o && o.message;
    if (o.type !== 'assistant' || !msg || !msg.usage || !msg.model || msg.model === '<synthetic>') continue;
    const t = Date.parse(o.timestamp);
    if (!Number.isFinite(t)) continue;
    const u = msg.usage;
    out.push({
      k: 'u', p: 'claude', t,
      id: hash(`c:${msg.id || ''}:${o.requestId || ''}:${msg.id ? '' : line}`, 20),
      sid: hash(o.sessionId || 'none', 12),
      m: String(msg.model).slice(0, 80),
      in: num(u.input_tokens), cw: num(u.cache_creation_input_tokens), cr: num(u.cache_read_input_tokens),
      out: num(u.output_tokens),
      ...(msg.stop_reason === 'end_turn' ? { end: 1 } : {}),
    });
  }
  return out;
}

// Codex: ~/.codex/sessions/**/rollout-*.jsonl. Newer logs have `token_usage_record` per response
// (exact, with response_id). Older logs only have cumulative `token_count`; we take deltas.
// ctx is per-file state that persists across reads: { sid, acctSub, model, hasRecords, prev }.
function parseCodex(lines, ctx) {
  const out = [];
  if (!ctx.hasRecords && lines.some((l) => l.includes('"token_usage_record"'))) ctx.hasRecords = true;
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o && o.payload;
    if (!p) continue;
    if (o.type === 'session_meta') {
      ctx.sid = hash(p.session_id || p.id || 'none', 12);
      ctx.acctSub = p.creator_account_id ? subId('codex', p.creator_account_id) : null;
      continue;
    }
    if (o.type === 'turn_context') { if (p.model) ctx.model = String(p.model).slice(0, 80); continue; }
    const t = Date.parse(o.timestamp);
    if (!Number.isFinite(t)) continue;
    if (o.type === 'event_msg' && p.type === 'token_count' && p.rate_limits) {
      const lim = codexLimits(p.rate_limits, t);
      const key = JSON.stringify(lim);
      // k 'hb' so peers on older versions accept it; only emitted when the numbers change
      if (lim.length && key !== ctx.limKey) { ctx.limKey = key; out.push({ k: 'hb', p: 'codex', t, id: hash(`xl:${ctx.sid}:${t}:${key}`, 20), acctSub: ctx.acctSub || null, lim }); }
    }
    if (o.type === 'token_usage_record' && p.usage) {
      out.push(codexEvent(p.usage, t, ctx, hash(`x:${p.response_id || ''}:${p.response_id ? '' : line}`, 20)));
    } else if (!ctx.hasRecords && o.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.total_token_usage) {
      const tot = p.info.total_token_usage;
      const prev = ctx.prev || {};
      if (!(num(tot.total_tokens) > num(prev.total_tokens))) continue;
      const d = {};
      for (const k of ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens']) {
        d[k] = Math.max(0, num(tot[k]) - num(prev[k]));
      }
      ctx.prev = tot;
      out.push(codexEvent(d, t, ctx, hash(`x:${ctx.sid}:${tot.total_tokens}`, 20)));
    }
  }
  return out;
}

function codexEvent(u, t, ctx, id) {
  const cached = num(u.cached_input_tokens);
  return {
    k: 'u', p: 'codex', t, id,
    sid: ctx.sid || 'none', m: ctx.model || 'codex-unknown', acctSub: ctx.acctSub || null,
    in: Math.max(0, num(u.input_tokens) - cached), // OpenAI input_tokens includes cached
    cr: cached, cw: num(u.cache_write_input_tokens), out: num(u.output_tokens), rs: num(u.reasoning_output_tokens),
  };
}

// rate_limits.primary/secondary: { used_percent, window_minutes, resets_at (s) | resets_in_seconds }
function codexLimits(rl, t) {
  const out = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || !(w.window_minutes > 0)) continue;
    const r = w.resets_at > 0 ? w.resets_at * 1000 : w.resets_in_seconds > 0 ? t + w.resets_in_seconds * 1000 : 0;
    if (r) out.push({ m: Math.round(w.window_minutes), u: Math.max(0, Math.min(100, Math.round(num(w.used_percent)))), r: Math.round(r) });
  }
  return out;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

module.exports = { parseClaude, parseCodex };
