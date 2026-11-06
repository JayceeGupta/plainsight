'use strict';
// Turns the merged event set into dashboard/MCP answers. Everything is grouped by subscription:
// numbers from different subscriptions are never added together.
const prices = require('./prices');

const RANGES = { '1h': 3600e3, '5h': 5 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 864e5, '30d': 30 * 864e5, '90d': 90 * 864e5 };
const ONLINE_MS = 5 * 60e3;
const LIVE_MS = 10 * 60e3;
const STREAK_GAP = 30 * 60e3;

function bucketSize(range) {
  return { '1h': 5 * 60e3, '5h': 15 * 60e3, '24h': 3600e3 }[range] || 864e5;
}

function emptyTotals() {
  return { in: 0, cr: 0, cw: 0, out: 0, rs: 0, tokens: 0, cost: 0, costInput: 0, costCacheRead: 0, costCacheWrite: 0, costOutput: 0, savings: 0, unpricedTokens: 0, requests: 0, sessions: 0 };
}

function add(tot, ev, c) {
  const tok = (ev.in || 0) + (ev.cr || 0) + (ev.cw || 0) + (ev.out || 0);
  tot.in += ev.in || 0; tot.cr += ev.cr || 0; tot.cw += ev.cw || 0; tot.out += ev.out || 0; tot.rs += ev.rs || 0;
  tot.tokens += tok; tot.requests++;
  if (c) {
    tot.costInput += c.input; tot.costCacheRead += c.cacheRead; tot.costCacheWrite += c.cacheWrite; tot.costOutput += c.output;
    tot.cost += c.input + c.cacheRead + c.cacheWrite + c.output; tot.savings += c.savings;
  } else tot.unpricedTokens += tok;
}

// Static facts from all events: machines, subscription labels, announcements.
function index(events) {
  const nodes = new Map();
  const subs = new Map();
  const anns = [];
  const usage = [];
  const colors = new Map(); // machine nick -> { c, t }, newest wins
  for (const ev of events) {
    let n = nodes.get(ev.o);
    if (!n) { n = { origin: ev.o, nick: ev.o.slice(0, 8), host: null, os: null, op: null, ver: null, lastSeen: 0, firstSeen: ev.t, bye: false, helloT: 0 }; nodes.set(ev.o, n); }
    if (ev.t >= n.lastSeen) { n.lastSeen = ev.t; n.bye = ev.k === 'bye'; }
    if (ev.t < n.firstSeen) n.firstSeen = ev.t;
    if (ev.k === 'hello' && ev.t >= n.helloT) {
      n.helloT = ev.t; n.nick = ev.nick || n.nick; n.host = ev.host || null; n.os = ev.os || null; n.op = ev.op || null; n.ver = ev.ver || null;
    } else if (ev.k === 'sub') {
      const s = subs.get(ev.sub);
      if (!s || ev.t >= s.t) subs.set(ev.sub, { sub: ev.sub, label: ev.label, provider: ev.p, t: ev.t });
    } else if (ev.k === 'ann') anns.push(ev);
    else if (ev.k === 'color') { const x = colors.get(ev.mach); if (!x || ev.t >= x.t) colors.set(ev.mach, { c: ev.c, t: ev.t }); }
    else if (ev.k === 'u') usage.push(ev);
  }
  return { nodes, subs, anns, usage, colors };
}

function machineName(nodes, origin) {
  const n = nodes.get(origin);
  return n ? n.nick : origin.slice(0, 8);
}

function parseList(v) {
  if (!v) return null;
  const a = (Array.isArray(v) ? v : String(v).split(',')).map((s) => s.trim()).filter(Boolean);
  return a.length ? new Set(a) : null;
}

// q: { range, subs, machines, providers, tz (minutes, as Date#getTimezoneOffset) }
function summarize(events, q = {}, now = Date.now()) {
  const range = RANGES[q.range] ? q.range : '7d';
  const from = now - RANGES[range];
  const step = bucketSize(range);
  const tzMs = (Number(q.tz) || 0) * 60e3;
  const align = (t) => (step >= 864e5 ? Math.floor((t - tzMs) / step) * step + tzMs : Math.floor(t / step) * step);
  const subsF = parseList(q.subs);
  const machF = parseList(q.machines);
  const provF = parseList(q.providers);

  const { nodes, subs, anns, usage, colors } = index(events);
  const subInfo = (id, p) => subs.get(id) || { sub: id, label: `${p || 'unknown'} ${id.slice(0, 6)}`, provider: p };
  const pass = (ev) => (!subsF || subsF.has(ev.sub)) && (!machF || machF.has(machineName(nodes, ev.o))) && (!provF || provF.has(ev.p));

  const bySub = new Map();
  const byModel = new Map();
  const byMachine = new Map();
  const buckets = new Map();
  const bucketsM = new Map();
  const sessionSets = new Map();
  const sessions = new Map(); // all-time per session, for live view
  const machineSubs = new Map();

  for (const ev of usage) {
    const mname = machineName(nodes, ev.o);
    if (!machineSubs.has(mname)) machineSubs.set(mname, new Set());
    machineSubs.get(mname).add(ev.sub);
    if (!pass(ev)) continue;
    const c = prices.cost(ev);
    const sk = `${ev.o}|${ev.sub}|${ev.sid}`;
    let s = sessions.get(sk);
    if (!s) { s = { machine: mname, origin: ev.o, sub: ev.sub, provider: ev.p, sid: ev.sid, start: ev.t, streak: ev.t, last: ev.t, model: ev.m, totals: emptyTotals() }; sessions.set(sk, s); }
    if (ev.t < s.start) s.start = ev.t;
    // "running for" = current stretch of activity; a 30 min pause (or a resumed old session) restarts it
    if (ev.t - s.last > STREAK_GAP) s.streak = ev.t;
    if (ev.t >= s.last) { s.last = ev.t; s.model = ev.m; }
    add(s.totals, ev, c);

    if (ev.t < from || ev.t > now + 60e3) continue;
    if (!bySub.has(ev.sub)) bySub.set(ev.sub, { ...subInfo(ev.sub, ev.p), provider: ev.p, totals: emptyTotals() });
    add(bySub.get(ev.sub).totals, ev, c);
    if (!sessionSets.has(ev.sub)) sessionSets.set(ev.sub, new Set());
    sessionSets.get(ev.sub).add(`${ev.o}|${ev.sid}`);

    const mk = `${ev.sub}|${ev.m}`;
    if (!byModel.has(mk)) byModel.set(mk, { sub: ev.sub, model: ev.m, provider: ev.p, priced: !!c, totals: emptyTotals() });
    add(byModel.get(mk).totals, ev, c);

    const hk = `${ev.sub}|${mname}`;
    if (!byMachine.has(hk)) byMachine.set(hk, { sub: ev.sub, machine: mname, totals: emptyTotals(), sessions: new Set() });
    const bm = byMachine.get(hk);
    add(bm.totals, ev, c);
    bm.sessions.add(ev.sid);

    const bt = align(ev.t);
    if (!buckets.has(bt)) buckets.set(bt, {});
    const b = buckets.get(bt);
    if (!b[ev.sub]) b[ev.sub] = emptyTotals();
    add(b[ev.sub], ev, c);
    // per-machine split of the same bucket (dashboard stacks machines inside one subscription)
    if (!bucketsM.has(bt)) bucketsM.set(bt, {});
    const bm2 = bucketsM.get(bt);
    const pm = (bm2[ev.sub] = bm2[ev.sub] || {});
    const cell = (pm[mname] = pm[mname] || { cost: 0, tokens: 0 });
    cell.tokens += (ev.in || 0) + (ev.cr || 0) + (ev.cw || 0) + (ev.out || 0);
    if (c) cell.cost += c.input + c.cacheRead + c.cacheWrite + c.output;
  }
  for (const [sub, set] of sessionSets) bySub.get(sub).totals.sessions = set.size;

  // Continuous bucket axis
  const series = [];
  for (let t = align(from); t <= now; t += step) series.push({ t, v: buckets.get(t) || {}, m: bucketsM.get(t) || {} });

  const machines = [...groupMachines(nodes, machineSubs, now).values()]
    .filter((m) => !machF || machF.has(m.nick))
    .sort((a, b) => b.lastSeen - a.lastSeen);

  const live = [...sessions.values()]
    .filter((s) => now - s.last < LIVE_MS)
    .map((s) => ({ ...s, label: subInfo(s.sub, s.provider).label }))
    .sort((a, b) => b.last - a.last);

  const announcements = anns
    .filter((a) => a.until > now && (!machF || machF.has(machineName(nodes, a.o))))
    .map((a) => ({ machine: machineName(nodes, a.o), op: (nodes.get(a.o) || {}).op || null, msg: a.msg, heavy: !!a.heavy, until: a.until, t: a.t }))
    .sort((a, b) => b.t - a.t);

  return {
    now, range, from, step,
    subscriptions: [...bySub.values()].sort((a, b) => b.totals.cost - a.totals.cost || b.totals.tokens - a.totals.tokens),
    models: [...byModel.values()].map((r) => ({ ...r, label: subInfo(r.sub, r.provider).label })).sort((a, b) => b.totals.cost - a.totals.cost || b.totals.tokens - a.totals.tokens),
    machineUsage: [...byMachine.values()].map((r) => ({ sub: r.sub, label: subInfo(r.sub).label, machine: r.machine, totals: { ...r.totals, sessions: r.sessions.size } })).sort((a, b) => b.totals.tokens - a.totals.tokens),
    series,
    live,
    announcements,
    machines,
    options: {
      subscriptions: [...subs.values()].map(({ sub, label, provider }) => ({ sub, label, provider })),
      machines: [...new Set([...nodes.values()].map((n) => n.nick))].sort(),
      // oldest first: a machine keeps its dashboard colour when new machines join
      colors: Object.fromEntries([...colors].map(([k, v]) => [k, v.c])),
      machineOrder: [...new Set([...nodes.values()].sort((a, b) => a.firstSeen - b.firstSeen).map((n) => n.nick))],
      providers: [...new Set(usage.map((e) => e.p))].sort(),
    },
  };
}

// Several origins can share a nickname (a rebuilt box); show them as one machine.
function groupMachines(nodes, machineSubs, now) {
  const out = new Map();
  for (const n of nodes.values()) {
    const online = !n.bye && now - n.lastSeen < ONLINE_MS;
    const m = out.get(n.nick) || { nick: n.nick, origins: [], online: false, lastSeen: 0, firstSeen: n.firstSeen, os: n.os, op: n.op, host: n.host, ver: n.ver, subs: [...(machineSubs.get(n.nick) || [])] };
    m.origins.push(n.origin);
    m.online = m.online || online;
    if (n.lastSeen > m.lastSeen) { m.lastSeen = n.lastSeen; m.os = n.os; m.op = n.op; m.host = n.host; m.ver = n.ver; }
    if (n.firstSeen < m.firstSeen) m.firstSeen = n.firstSeen;
    out.set(n.nick, m);
  }
  return out;
}

module.exports = { summarize, RANGES };
