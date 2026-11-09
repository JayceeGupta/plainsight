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

test('live: a prompt shows the session at once; end_turn ends the turn', () => {
  const now = Date.now();
  const P = (t) => JSON.stringify({ type: 'user', uuid: 'u' + t, sessionId: 'S1', timestamp: new Date(t).toISOString(), message: { role: 'user', content: 'write an essay' } });
  const A = (t, stop) => JSON.stringify({ type: 'assistant', requestId: 'r' + t, sessionId: 'S1', timestamp: new Date(t).toISOString(), message: { id: 'm' + t, model: 'claude-opus-5-5', stop_reason: stop, usage: { input_tokens: 1, output_tokens: 9 } } });
  const tool = JSON.stringify({ type: 'user', sessionId: 'S1', timestamp: new Date(now).toISOString(), message: { role: 'user', content: [{ type: 'tool_result' }] } });
  const evs = parseClaude([P(now - 20e3), tool, A(now - 5e3, 'end_turn')], {});
  assert.deepStrictEqual(evs.map((e) => [e.k, e.turn, e.end]), [['hb', 1, undefined], ['u', undefined, 1]]);
  const s = new Store(tmp());
  const base = [{ k: 'hello', nick: 'box-a' }, { k: 'sub', sub: 'sub1', p: 'claude', label: 'Max' }];
  s.appendLocal(B, [...base, ...parseClaude([P(now - 20e3)], {}).map((e) => ({ ...e, sub: 'sub1' }))]);
  const busy = summarize(s.all(), { range: '24h' }, now).live;
  assert.deepStrictEqual(busy.map((x) => [x.active, x.model]), [[true, null]]);
  s.appendLocal(B, parseClaude([A(now - 5e3, 'end_turn')], {}).map((e) => ({ ...e, sub: 'sub1' })));
  const done = summarize(s.all(), { range: '24h' }, now).live;
  assert.deepStrictEqual(done.map((x) => [x.active, x.model, x.blocks.length, x.blocks[0].n]), [[false, 'claude-opus-5-5', 1, 1]]);
});

test('aggregate: live sessions carry blocks of work split by 10 min pauses', () => {
  const s = new Store(tmp());
  const now = Date.now(), M = 60e3;
  const u = (id, ago) => ({ k: 'u', p: 'claude', sub: 'sub1', sid: 's', m: 'x', in: 1, cr: 0, cw: 0, out: 1, id, t: now - ago * M });
  s.appendLocal(A, [{ k: 'hello', nick: 'box-a' }, { k: 'sub', sub: 'sub1', p: 'claude', label: 'Max' }, u('a', 60), u('b', 55), u('c', 30), u('d', 2), u('e', 1)]);
  const b = summarize(s.all(), { range: '24h' }, now).live[0].blocks;
  assert.deepStrictEqual(b.map((x) => [x.n, x.k, (now - x.a) / M, (now - x.b) / M]), [[2, 4, 60, 55], [1, 2, 30, 30], [2, 4, 2, 1]]);
});

test('aggregate: first machine names a subscription; limits give bands, resets and the window range', () => {
  const s = new Store(tmp());
  const now = Date.parse('2026-11-09T12:00:00Z');
  const H = 3600e3, wk = 7 * 864e5;
  s.appendLocal(A, [{ k: 'sub', sub: 'x', p: 'claude', label: 'Claude Max', t: now - 10 * H },
    { k: 'u', p: 'claude', sub: 'x', sid: 's', m: 'm', in: 1, cr: 0, cw: 0, out: 1, id: 'u1', t: now - 2 * H },
    { k: 'hb', sub: 'x', p: 'claude', t: now - 6 * H, lim: [{ m: 300, u: 90, r: now - 4 * H }, { m: 10080, u: 50, r: now + 2 * 864e5 }] },
    { k: 'hb', sub: 'x', p: 'claude', t: now - H, lim: [{ m: 300, u: 20, r: now + 3 * H }, { m: 10080, u: 60, r: now + 2 * 864e5 }] }]);
  s.appendLocal(B, [{ k: 'sub', sub: 'x', p: 'claude', label: 'renamed later', t: now - H }]);
  const d = summarize(s.all(), { range: '7d' }, now);
  assert.strictEqual(d.subscriptions[0].label, 'Claude Max');
  const L = d.limits.x;
  assert.deepStrictEqual(L.windows.map((w) => [w.m, w.u]), [[300, 20], [10080, 60]]);
  assert.deepStrictEqual(L.bands, [[now - 9 * H, now - 4 * H, 90], [now - 2 * H, now + 3 * H, 20]]);
  assert.ok(L.windows[0].split[Object.keys(L.windows[0].split)[0]] >= 0);
  assert.strictEqual(summarize(s.all(), { range: '7d', res: 'day' }, now).step, 864e5);
  assert.deepStrictEqual(L.resets, [now + 2 * 864e5 - wk]);
  const w = summarize(s.all(), { range: 'win' }, now);
  assert.strictEqual(w.limitSub, 'x');
  assert.strictEqual(w.from, now - 2 * H);
  assert.strictEqual(w.subscriptions[0].totals.tokens, 2);
  // a store on an older version must still accept these heartbeats; garbage lim is refused
  assert.throws(() => s.appendLocal(A, [{ k: 'hb', lim: [{ m: 'x' }] }]), /bad lim/);
});

test('codex parser: rate limits become heartbeat events only when they change', () => {
  const rl = (u) => JSON.stringify({ timestamp: '2026-11-01T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: u, window_minutes: 300, resets_at: 1793570000 }, secondary: null } } });
  const evs = parseCodex([rl(10), rl(10), rl(12)], {});
  assert.deepStrictEqual(evs.map((e) => [e.k, e.lim[0].u, e.lim[0].r]), [['hb', 10, 1793570000000], ['hb', 12, 1793570000000]]);
});

test('pool: default policy becomes isolated; custom policy is flagged', () => {
  const { policy, isDefault } = buildPolicy({ grants: [{ src: ['*'], dst: ['*'], ip: ['*'] }], ssh: [1] }, '100.1.2.3');
  assert.ok(isDefault);
  assert.ok(!policy.grants.some((g) => g.src[0] === '*'));
  assert.deepStrictEqual(policy.ssh, [1]);
  assert.ok(policy.grants.some((g) => g.src[0] === 'tag:plainsight' && g.dst[0] === 'tag:plainsight' && g.ip[0] === 'tcp:4747'));
  assert.ok(!buildPolicy({ grants: [{ src: ['group:x'], dst: ['*'], ip: ['*'] }] }).isDefault);
});

test('pool: rules from the old tailnet dashboard are removed, hand-written tests kept', () => {
  const cur = {
    tagOwners: { 'tag:plainsight': ['autogroup:admin'], 'tag:plainsight-viewer': ['autogroup:admin'] },
    grants: [{ src: ['autogroup:member'], dst: ['svc:plainsight'], ip: ['tcp:443'] }, { src: ['tag:plainsight-viewer'], dst: ['svc:plainsight'], ip: ['tcp:80'] }],
    autoApprovers: { services: { 'svc:plainsight': ['tag:plainsight'] } },
    tests: [{ src: 'tag:plainsight', deny: ['100.9.9.9:80'] }, { src: 'tag:plainsight-viewer', accept: ['100.1.2.3:80'] }],
  };
  const { policy } = buildPolicy(cur, '100.1.2.3');
  const s = JSON.stringify(policy);
  assert.ok(!s.includes('svc:plainsight') && !s.includes('plainsight-viewer'));
  assert.ok(!policy.autoApprovers);
  assert.ok(policy.tests.some((t) => JSON.stringify(t) === JSON.stringify({ src: 'tag:plainsight', deny: ['100.9.9.9:80'] })));
});

test('pool: re-running bootstrap is stable (no duplicate grants/tests); members reach boxes on 4747 only', () => {
  const start = { grants: [{ src: ['*'], dst: ['*'], ip: ['*'] }], ssh: [{ action: 'check' }], tests: [{ src: 'tag:plainsight', deny: ['100.9.9.9:80'] }] };
  const once = buildPolicy(start).policy;
  const twice = buildPolicy(once).policy;
  assert.deepStrictEqual(twice.grants, once.grants);
  assert.deepStrictEqual(twice.tests, once.tests);
  assert.strictEqual(new Set(once.grants.map((g) => JSON.stringify(g))).size, once.grants.length);
  assert.ok(once.grants.some((g) => g.src[0] === 'autogroup:member' && g.dst[0] === 'tag:plainsight' && g.ip.join() === 'tcp:4747'));
  assert.ok(!once.grants.some((g) => g.dst.includes('tag:plainsight') && g.ip.includes('*')));
  assert.deepStrictEqual(once.ssh, [{ action: 'check' }]);
});

test('gate worker shows the offline page when the tunnel has no connector', async () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'web', 'gate-worker.js'), 'utf8');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('error 1033', { status: 530 });
    const page = await mod.default.fetch(new Request('https://u.example/'));
    assert.strictEqual(page.status, 503);
    assert.match(await page.text(), /No machine is online/);
    const api = await mod.default.fetch(new Request('https://u.example/api/summary'));
    assert.strictEqual(api.headers.get('content-type').split(';')[0], 'application/json');
    globalThis.fetch = async () => new Response('ok', { status: 200 });
    assert.strictEqual(await (await mod.default.fetch(new Request('https://u.example/'))).text(), 'ok');
  } finally { globalThis.fetch = real; }
});
