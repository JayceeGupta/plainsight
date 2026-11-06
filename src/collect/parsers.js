'use strict';
// Pure parsers: transcript lines in, usage events out. Only numbers, model names and hashed ids leave here.
const { hash, subId } = require('../util');

// Claude Code: ~/.claude/projects/**/*.jsonl. One assistant message can span several lines
// (one per content block) that repeat the same usage; dedupe by message id + request id.
function parseClaude(lines, ctx) {
  const out = [];
  for (const line of lines) {
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

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

module.exports = { parseClaude, parseCodex };
