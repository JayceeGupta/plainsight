'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PLAINSIGHT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'plainsight-test-'));
const { Store } = require('../src/store');
const { parseClaude, parseCodex } = require('../src/collect/parsers');
const { summarize } = require('../src/aggregate');
const { giveFor, ingestAll } = require('../src/sync');
const { buildPolicy } = require('../src/pool');

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));

test('store: local append, seq, reload, crash-truncated tail', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.appendLocal(A, [{ k: 'hb' }, { k: 'hb' }]);
  assert.deepStrictEqual(s.vv(), { [A]: 2 });
  fs.appendFileSync(path.join(dir, `${A}.jsonl`), '{"o":"aaaa'); // partial line
  const s2 = new Store(dir);
  assert.strictEqual(s2.get(A).length, 2);
  assert.ok(fs.readFileSync(path.join(dir, `${A}.jsonl`), 'utf8').endsWith('\n'));
});

test('store: ingest rejects gaps, bad events, own origin; accepts overlap', () => {
  const src = new Store(tmp());
  src.appendLocal(A, [{ k: 'hb' }, { k: 'hb' }, { k: 'hb' }]);
  const dst = new Store(tmp());
  assert.strictEqual(dst.ingest(A, 2, src.linesAfter(A, 1, 10), B), 0, 'gap');
  assert.strictEqual(dst.ingest(A, 1, src.linesAfter(A, 0, 2), B), 2);
  assert.strictEqual(dst.ingest(A, 1, src.linesAfter(A, 0, 3), B), 1, 'overlap skipped');
  assert.strictEqual(dst.ingest(B, 1, ['{"o":"bbbbbbbbbbbbbbbb","s":1,"t":1,"k":"hb"}'], 'cccccccccccccccc'), 0, 'bad time');
  assert.strictEqual(dst.ingest(A, 4, ['x'], A), 0, 'own origin');
});

test('sync: two stores converge both ways', () => {
  const x = new Store(tmp()), y = new Store(tmp());
  x.appendLocal(A, [{ k: 'hb' }]);
  y.appendLocal(B, [{ k: 'hb' }, { k: 'hb' }]);
  ingestAll(y, giveFor(x, y.vv()), B);
  ingestAll(x, giveFor(y, x.vv()), A);
  assert.deepStrictEqual(x.vv(), y.vv());
});

test('claude parser: dedupe-ready ids, skips synthetic and non-usage lines', () => {
  const line = (id, out) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-01T10:00:00Z', sessionId: 's1', requestId: 'r1', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: out } } });
  const evs = parseClaude([line('m1', 7), line('m1', 7), JSON.stringify({ type: 'user', message: { content: 'secret' } }), JSON.stringify({ type: 'assistant', timestamp: '2026-11-01T10:00:00Z', message: { id: 'z', model: '<synthetic>', usage: {} } })], {});
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(evs[0].id, evs[1].id);
  assert.deepStrictEqual([evs[0].in, evs[0].cw, evs[0].cr, evs[0].out], [5, 10, 100, 7]);
  assert.ok(!JSON.stringify(evs).includes('secret'));
});

test('codex parser: records preferred, legacy token_count deltas, account per session', () => {
  const meta = JSON.stringify({ timestamp: '2026-11-01T10:00:00Z', type: 'session_meta', payload: { session_id: 'S', creator_account_id: 'acct-1' } });
  const ctxL = JSON.stringify({ timestamp: '2026-11-01T10:00:00Z', type: 'turn_context', payload: { model: 'gpt-6-luna' } });
  const rec = JSON.stringify({ timestamp: '2026-11-01T10:00:01Z', type: 'token_usage_record', payload: { response_id: 'r1', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 9, reasoning_output_tokens: 3 } } });
  const cnt = (tot) => JSON.stringify({ timestamp: '2026-11-01T10:00:02Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: tot, cached_input_tokens: 0, output_tokens: 1, total_tokens: tot + 1 } } } });
  const a = parseCodex([meta, ctxL, rec, cnt(100)], {});
  assert.strictEqual(a.length, 1);
  assert.deepStrictEqual([a[0].in, a[0].cr, a[0].out, a[0].rs, a[0].m], [40, 60, 9, 3, 'gpt-6-luna']);
  assert.ok(a[0].acctSub);
  const ctx = {};
  const b = parseCodex([meta, ctxL, cnt(100), cnt(100), cnt(150)], ctx);
  assert.strictEqual(b.length, 2);
  assert.strictEqual(b[1].in, 50);
});

test('aggregate: subscriptions are never summed together', () => {
  const s = new Store(tmp());
  const now = Date.now();
  s.appendLocal(A, [
    { k: 'hello', nick: 'box-a' }, { k: 'sub', sub: 'sub1', p: 'claude', label: 'Max one' }, { k: 'sub', sub: 'sub2', p: 'claude', label: 'Max two' },
    { k: 'u', p: 'claude', sub: 'sub1', sid: 's', m: 'unknown-model', in: 10, cr: 0, cw: 0, out: 5, id: 'i1', t: now - 1000 },
    { k: 'u', p: 'claude', sub: 'sub2', sid: 't', m: 'unknown-model', in: 1, cr: 0, cw: 0, out: 1, id: 'i2', t: now - 1000 },
  ]);
  const d = summarize(s.all(), { range: '24h' }, now);
  assert.strictEqual(d.subscriptions.length, 2);
  assert.deepStrictEqual(d.subscriptions.map((x) => x.totals.tokens).sort(), [15, 2]);
  assert.strictEqual(d.live.length, 2);
  assert.strictEqual(d.machines[0].nick, 'box-a');
  const only = summarize(s.all(), { range: '24h', subs: 'sub2' }, now);
  assert.deepStrictEqual(only.subscriptions.map((x) => x.label), ['Max two']);
});

test('pool: default policy becomes isolated; custom policy is flagged', () => {
  const { policy, isDefault } = buildPolicy({ grants: [{ src: ['*'], dst: ['*'], ip: ['*'] }], ssh: [1] }, '100.1.2.3');
  assert.ok(isDefault);
  assert.ok(!policy.grants.some((g) => g.src[0] === '*'));
  assert.deepStrictEqual(policy.ssh, [1]);
  assert.ok(policy.autoApprovers.services['svc:plainsight']);
  assert.ok(!buildPolicy({ grants: [{ src: ['group:x'], dst: ['*'], ip: ['*'] }] }).isDefault);
});
