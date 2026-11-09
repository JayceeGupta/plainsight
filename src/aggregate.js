'use strict';
// Turns the merged event set into dashboard/MCP answers. Everything is grouped by subscription:
// numbers from different subscriptions are never added together.
const prices = require('./prices');

const RANGES = { '1h': 3600e3, '5h': 5 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 864e5, '30d': 30 * 864e5, '90d': 90 * 864e5 };
// 'win' / 'week': from the start of the current short / long limit window of one subscription
const LIMIT_RANGES = { win: 900e3, week: 3600e3 };
const ONLINE_MS = 5 * 60e3;
const LIVE_MS = 10 * 60e3;
const STREAK_GAP = 30 * 60e3;
const BURST_GAP = 10 * 60e3;
const MAX_BLOCKS = 300;

function bucketSize(range, res) {
  if (range === '7d' && res === 'day') return 864e5;
  return { '1h': 5 * 60e3, '5h': 15 * 60e3, '24h': 3600e3, '7d': 3600e3, ...LIMIT_RANGES }[range] || 864e5;
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
  const lims = []; // hb events carrying plan limits
  const subFirst = new Map(); // sub -> origin that announced it first (its label wins)
  const subLabels = new Map(); // sub|origin -> newest sub event
  const colors = new Map(); // machine nick -> { c, t }, newest wins
  for (const ev of events) {
    let n = nodes.get(ev.o);
    if (!n) { n = { origin: ev.o, nick: ev.o.slice(0, 8), host: null, os: null, op: null, ver: null, lastSeen: 0, firstSeen: ev.t, bye: false, helloT: 0 }; nodes.set(ev.o, n); }
    if (ev.t >= n.lastSeen) { n.lastSeen = ev.t; n.bye = ev.k === 'bye'; }
    if (ev.t < n.firstSeen) n.firstSeen = ev.t;
    if (ev.k === 'hello' && ev.t >= n.helloT) {
      n.helloT = ev.t; n.nick = ev.nick || n.nick; n.host = ev.host || null; n.os = ev.os || null; n.op = ev.op || null; n.ver = ev.ver || null;
    } else if (ev.k === 'sub') {
      const f = subFirst.get(ev.sub);
      if (!f || ev.t < f.t) subFirst.set(ev.sub, { o: ev.o, t: ev.t });
      const lk = `${ev.sub}|${ev.o}`, l = subLabels.get(lk);
      if (!l || ev.t >= l.t) subLabels.set(lk, ev);
    } else if (ev.k === 'hb' && ev.sub && Array.isArray(ev.lim)) lims.push(ev); else if (ev.k === 'ann') anns.push(ev);
    else if (ev.k === 'color') { const x = colors.get(ev.mach); if (!x || ev.t >= x.t) colors.set(ev.mach, { c: ev.c, t: ev.t }); }
    else if (ev.k === 'u') usage.push(ev);
  }
  // Every machine on a subscription announces its own label; the first machine to announce it names it.
  for (const [sub, f] of subFirst) { const ev = subLabels.get(`${sub}|${f.o}`); subs.set(sub, { sub, label: ev.label, provider: ev.p, t: ev.t }); }
  return { nodes, subs, anns, usage, colors, lims };
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
  const { nodes, subs, anns, usage, colors, lims } = index(events);
  const subsF = parseList(q.subs);
  const limits = limitInfo(lims, now);
  let range = RANGES[q.range] || LIMIT_RANGES[q.range] ? q.range : '7d';
  let from = now - (RANGES[range] || 0);
  let limitSub = null;
  if (LIMIT_RANGES[range]) {
    // one subscription in view, with known limits; otherwise fall back to a plain range
    const cand = Object.keys(limits).filter((s) => !subsF || subsF.has(s));
    const w = cand.length === 1 && limits[cand[0]].windows.slice().sort((a, b) => a.m - b.m)[range === 'win' ? 0 : limits[cand[0]].windows.length - 1];
    if (w) { limitSub = cand[0]; from = w.start; } else { range = range === 'win' ? '5h' : '7d'; from = now - RANGES[range]; }
  }
  const step = bucketSize(range, q.res);
  const tzMs = (Number(q.tz) || 0) * 60e3;
  const align = (t) => (step >= 864e5 ? Math.floor((t - tzMs) / step) * step + tzMs : Math.floor(t / step) * step);
  const machF = parseList(q.machines);
  const provF = parseList(q.providers);

  const subInfo = (id, p) => subs.get(id) || { sub: id, label: `${p || 'unknown'} ${id.slice(0, 6)}`, provider: p };
  const pass = (ev) => (!subsF || subsF.has(ev.sub)) && (!machF || machF.has(machineName(nodes, ev.o))) && (!provF || provF.has(ev.p));

  const bySub = new Map();
  const byModel = new Map();
  const byMachine = new Map();
  const byModelMachine = new Map();
  const buckets = new Map();
  const bucketsM = new Map();
  const bucketsX = new Map();
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

    const xk = `${ev.sub}|${ev.m}|${mname}`;
    if (!byModelMachine.has(xk)) byModelMachine.set(xk, { sub: ev.sub, model: ev.m, machine: mname, totals: emptyTotals() });
    add(byModelMachine.get(xk).totals, ev, c);

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
    const tok = (ev.in || 0) + (ev.cr || 0) + (ev.cw || 0) + (ev.out || 0);
    const cc = c ? c.input + c.cacheRead + c.cacheWrite + c.output : 0;
    cell.tokens += tok; cell.cost += cc;
    // per model and machine (model modal chart): x[sub|model|machine] = [cost, tokens]
    if (!bucketsX.has(bt)) bucketsX.set(bt, {});
    const bx = bucketsX.get(bt);
    const xc = (bx[xk] = bx[xk] || [0, 0]);
    xc[0] += cc; xc[1] += tok;
  }
  for (const [sub, set] of sessionSets) bySub.get(sub).totals.sessions = set.size;

  // Continuous bucket axis
  const series = [];
  for (let t = align(from); t <= now; t += step) series.push({ t, v: buckets.get(t) || {}, m: bucketsM.get(t) || {}, x: bucketsX.get(t) || {} });

  const machines = [...groupMachines(nodes, machineSubs, now).values()]
    .filter((m) => !machF || machF.has(m.nick))
    .sort((a, b) => b.lastSeen - a.lastSeen);

  const live = [...sessions.values()]
    .filter((s) => now - s.last < LIVE_MS)
    .map((s) => ({ ...s, label: subInfo(s.sub, s.provider).label }))
    .sort((a, b) => b.last - a.last);
  // second pass, only for live sessions: their messages grouped into blocks of work
  // { a: first message, b: last message, c: cost, k: tokens, n: messages }
  const msgs = new Map(live.map((s) => [`${s.origin}|${s.sub}|${s.sid}`, []]));
  if (msgs.size) for (const ev of usage) {
    const list = msgs.get(`${ev.o}|${ev.sub}|${ev.sid}`);
    if (!list || !pass(ev)) continue;
    const c = prices.cost(ev);
    list.push([ev.t, c ? c.input + c.cacheRead + c.cacheWrite + c.output : 0, (ev.in || 0) + (ev.cr || 0) + (ev.cw || 0) + (ev.out || 0)]);
  }
  for (const s of live) {
    const blocks = [];
    for (const [t, c, k] of msgs.get(`${s.origin}|${s.sub}|${s.sid}`).sort((x, y) => x[0] - y[0])) {
      const l = blocks[blocks.length - 1];
      if (l && t - l.b <= BURST_GAP) { l.b = t; l.c += c; l.k += k; l.n++; } else blocks.push({ a: t, b: t, c, k, n: 1 });
    }
    s.blocks = blocks.slice(-MAX_BLOCKS);
  }

  const announcements = anns
    .filter((a) => a.until > now && (!machF || machF.has(machineName(nodes, a.o))))
    .map((a) => ({ machine: machineName(nodes, a.o), op: (nodes.get(a.o) || {}).op || null, msg: a.msg, heavy: !!a.heavy, until: a.until, t: a.t }))
    .sort((a, b) => b.t - a.t);

  // limit marks inside the shown period, per subscription in view
  const inView = new Set(bySub.keys());
  for (const s of Object.keys(limits)) if (subsF && !subsF.has(s)) inView.delete(s); else if (!subsF) inView.add(s);
  const limitsOut = {};
  for (const s of inView) {
    const L = limits[s];
    if (!L) continue;
    // who used the current windows: estimated cost per machine since each window started
    const windows = L.windows.map((w) => {
      const split = {};
      if (w.start < now) for (const ev of usage) {
        if (ev.sub !== s || ev.t < w.start || ev.t > now + 60e3) continue;
        const c = prices.cost(ev);
        const mn = machineName(nodes, ev.o);
        split[mn] = (split[mn] || 0) + (c ? c.input + c.cacheRead + c.cacheWrite + c.output : 0);
      }
      return { ...w, split };
    });
    limitsOut[s] = {
      t: L.t, windows,
      // short windows only up to 7 days, as their own bands
      bands: now - from <= RANGES['7d'] + 3600e3 ? L.bands.filter(([a, b]) => b > from && a < now) : [],
      resets: L.resets(from, now),
    };
  }

  return {
    now, range, from, step, limitSub, limits: limitsOut,
    subscriptions: [...bySub.values()].sort((a, b) => b.totals.cost - a.totals.cost || b.totals.tokens - a.totals.tokens),
    models: [...byModel.values()].map((r) => ({ ...r, label: subInfo(r.sub, r.provider).label })).sort((a, b) => b.totals.cost - a.totals.cost || b.totals.tokens - a.totals.tokens),
    modelMachines: [...byModelMachine.values()],
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

// Latest plan limits per subscription, plus past short windows and long-window reset times.
// lims: hb events { sub, t, lim: [{ m: minutes, u: % used, r: reset ms }] }
function limitInfo(lims, now) {
  const by = {};
  for (const ev of lims) (by[ev.sub] = by[ev.sub] || []).push(ev);
  const out = {};
  for (const [sub, evs] of Object.entries(by)) {
    evs.sort((a, b) => a.t - b.t);
    const last = evs[evs.length - 1];
    const ms = [...new Set(last.lim.map((w) => w.m))].sort((a, b) => a - b);
    const windows = ms.map((m) => {
      const w = last.lim.find((x) => x.m === m);
      let r = w.r, u = w.u;
      const len = m * 60e3;
      // a fixed-period window (weekly/monthly) rolls over on its own; a lapsed 5h window is just empty
      if (r <= now) { u = 0; if (m >= 1440) r += Math.ceil((now - r) / len) * len; }
      return { m, u, r, start: r > now ? r - len : now, asOf: last.t };
    });
    // every short window ever seen = one band
    const bands = [];
    const shortM = ms[0];
    if (shortM && shortM < 1440 && ms.length > 1) {
      // [start, end, highest % used seen in that window]
      const seen = new Map();
      for (const ev of evs) for (const w of ev.lim) {
        if (w.m !== shortM) continue;
        const r = Math.round(w.r / 60e3) * 60e3; // events stored before rounding was added
        const b = seen.get(r);
        if (b) b[2] = Math.max(b[2], w.u); else { const nb = [r - shortM * 60e3, r, w.u]; seen.set(r, nb); bands.push(nb); }
      }
    }
    const longW = windows.filter((w) => w.m >= 1440).pop();
    out[sub] = {
      t: last.t, windows, bands,
      resets: (from, to) => {
        if (!longW) return [];
        const len = longW.m * 60e3, res = [];
        for (let r = longW.r - Math.ceil((longW.r - from) / len) * len; r <= to; r += len) if (r >= from) res.push(r);
        return res;
      },
    };
  }
  return out;
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
