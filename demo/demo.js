// The demo: the real dashboard page and the real aggregation code, fed made-up events instead of
// a daemon. build.js puts this file in front of the page's own script and drops src/aggregate.js
// in at the AGGREGATE mark, so the demo can never drift from the real thing.
//
// Everything here is invented: a small team, six machines, four subscriptions. History is built
// from the visitor's clock (the same day always gets the same sessions), then a few live sessions
// keep working so the page moves on its own.
(() => {
  'use strict';
  window.PLAINSIGHT_DEMO = true;
  // first visit: two machines open, so the sessions and models running on them show without a click
  try { if (localStorage.getItem('ps:mopen') == null) localStorage.setItem('ps:mopen', JSON.stringify(['maya-mbp', 'arjun-desktop'])); } catch {}

  // ---- prices (the daemon reads LiteLLM's table; the demo carries its own few rows)
  const PER_M = 1e-6;
  const PRICE = {
    'claude-fable-5-2': [10, 50, 1, 12.5],
    'claude-opus-5-5': [5, 25, 0.5, 6.25],
    'claude-sonnet-5-5': [3, 15, 0.3, 3.75],
    'claude-haiku-5-5': [1, 5, 0.1, 1.25],
    'gpt-5.4-codex': [1.25, 10, 0.125, 1.25],
    'gpt-5.4-mini': [0.25, 2, 0.025, 0.25],
  };
  const demoPrices = {
    cost(ev) {
      const p = PRICE[ev.m];
      if (!p) return null;
      return { input: (ev.in || 0) * p[0] * PER_M, output: (ev.out || 0) * p[1] * PER_M, cacheRead: (ev.cr || 0) * p[2] * PER_M, cacheWrite: (ev.cw || 0) * p[3] * PER_M, savings: (ev.cr || 0) * (p[0] - p[2]) * PER_M };
    },
  };
  const costOf = (ev) => { const c = demoPrices.cost(ev); return c.input + c.output + c.cacheRead + c.cacheWrite; };

  const { summarize } = (() => {
    const module = { exports: {} };
    const require = () => demoPrices; // aggregate.js needs only ./prices
    /*AGGREGATE*/
    return module.exports;
  })();

  // ---- the cast
  const MIN = 60e3, HOUR = 3600e3, DAY = 864e5, WEEK = 7 * DAY;
  const NOW0 = Date.now();
  const MACH = [
    { o: '7c1e9a40b2d3f001', nick: 'maya-mbp', op: 'Maya', os: 'macOS 15.4', ver: '0.5.0', first: 88 },
    { o: '7c1e9a40b2d3f002', nick: 'arjun-desktop', op: 'Arjun', os: 'Windows 11', ver: '0.5.0', first: 88 },
    { o: '7c1e9a40b2d3f003', nick: 'build-box', op: 'Maya', os: 'Ubuntu 24.04', ver: '0.5.0', first: 47 },
    { o: '7c1e9a40b2d3f004', nick: 'arjun-laptop', op: 'Arjun', os: 'Windows 11', ver: '0.5.0', first: 61 },
    { o: '7c1e9a40b2d3f005', nick: 'lena-pc', op: 'Lena', os: 'Windows 11', ver: '0.4.0', first: 33 },
    { o: '7c1e9a40b2d3f006', nick: 'old-imac', op: 'Lena', os: 'macOS 13.6', ver: '0.3.2', first: 88, gone: 12 },
  ];
  const M = Object.fromEntries(MACH.map((m) => [m.nick, m]));
  // t5 / tw / tf: how much of the 5-hour, weekly and weekly-Fable limit the demo should show as used
  // right now (the budgets are worked back from that); no5: a plan without a 5-hour limit;
  // readers: the machines that check the limits
  const SUBS = [
    { sub: 'c3a91f0e77d1', label: 'Claude Ultra', p: 'claude', no5: true, tw: 0.64, tf: 0.79, anchor: [2, 9], readers: ['arjun-desktop', 'build-box'], bank: { n: 1, until: NOW0 + 19 * DAY } },
    { sub: 'c3a91f0e77d2', label: 'Claude Pro', p: 'claude', b5: 6, t5: 1.3, tw: 0.87, anchor: [5, 14], readers: ['lena-pc', 'arjun-laptop'] },
    { sub: 'c3a91f0e77d3', label: 'ChatGPT Pro', p: 'codex', b5: 9, t5: 0.22, tw: 0.41, anchor: [0, 20], readers: ['arjun-desktop', 'build-box'] },
    { sub: 'c3a91f0e77d4', label: 'ChatGPT Plus', p: 'codex', b5: 0.5, t5: 0.3, tw: 0.18, anchor: [(new Date().getDay() + 4) % 7, 11], readers: ['lena-pc'] },
  ];
  const SUB = Object.fromEntries(SUBS.map((s) => [s.label, s]));
  // who works where: sessions a day, the hours they start in, how long they run (minutes), models
  const HABITS = [
    { m: 'maya-mbp', s: 'Claude Ultra', perDay: 3, hours: [9, 17], dur: [45, 130], models: [['claude-fable-5-2', 5], ['claude-opus-5-5', 3], ['claude-sonnet-5-5', 2]], weekend: 0.25 },
    { m: 'arjun-desktop', s: 'Claude Ultra', perDay: 1.8, hours: [18, 23], dur: [50, 120], models: [['claude-fable-5-2', 2], ['claude-opus-5-5', 4], ['claude-sonnet-5-5', 4]], weekend: 1.3 },
    { m: 'build-box', s: 'Claude Ultra', perDay: 0.8, hours: [0, 3], dur: [150, 260], models: [['claude-sonnet-5-5', 8], ['claude-haiku-5-5', 2]], weekend: 1 },
    { m: 'arjun-desktop', s: 'ChatGPT Pro', perDay: 1.2, hours: [13, 18], dur: [40, 120], models: [['gpt-5.4-codex', 1]], weekend: 0.8 },
    { m: 'build-box', s: 'ChatGPT Pro', perDay: 0.5, hours: [4, 7], dur: [120, 240], models: [['gpt-5.4-codex', 1]], weekend: 1 },
    { m: 'arjun-laptop', s: 'Claude Pro', perDay: 0.9, hours: [10, 21], dur: [25, 70], models: [['claude-sonnet-5-5', 6], ['claude-haiku-5-5', 4]], weekend: 1.4 },
    { m: 'lena-pc', s: 'Claude Pro', perDay: 1.4, hours: [14, 21], dur: [30, 90], models: [['claude-sonnet-5-5', 1]], weekend: 0.6 },
    { m: 'lena-pc', s: 'ChatGPT Plus', perDay: 0.8, hours: [10, 14], dur: [20, 60], models: [['gpt-5.4-mini', 7], ['gpt-5.4-codex', 3]], weekend: 0.5 },
    { m: 'old-imac', s: 'Claude Pro', perDay: 0.6, hours: [11, 19], dur: [20, 50], models: [['claude-haiku-5-5', 1]], weekend: 0.5 },
  ];

  // ---- small tools
  const rng = (seed) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (r, list) => { let x = r() * list.reduce((a, i) => a + i[1], 0); for (const [v, w] of list) { x -= w; if (x <= 0) return v; } return list[0][0]; };
  const hex = (r, n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
  // one request: mostly cache reads, some cache writes, a little fresh input and the reply
  const request = (r, k = 1) => ({ in: Math.round(300 + r() * 2500), cr: Math.round((40e3 + r() * 260e3) * k), cw: Math.round((2e3 + r() * 22e3) * k), out: Math.round((400 + r() * 3600) * k) });

  const midnight = new Date(NOW0); midnight.setHours(0, 0, 0, 0);
  const QUIET = 3 * HOUR; // the last hours are written by hand below, so the picture on arrival is known

  // ---- history: candidate requests per subscription
  const cands = Object.fromEntries(SUBS.map((s) => [s.sub, []]));
  HABITS.forEach((h, hi) => {
    const mach = M[h.m], sub = SUB[h.s];
    for (let d = 89; d >= 0; d--) {
      if (d > mach.first || (mach.gone && d < mach.gone)) continue;
      const day0 = midnight.getTime() - d * DAY, dow = new Date(day0 + 12 * HOUR).getDay();
      const r = rng(Math.round(day0 / DAY) * 131 + hi * 7919);
      const n = Math.floor(h.perDay * (dow === 0 || dow === 6 ? h.weekend : 1) + r());
      const coarse = d > 8 ? 5 : 1; // older days are only ever shown per day: fewer, larger events
      for (let i = 0; i < n; i++) {
        const start = day0 + (h.hours[0] + r() * (h.hours[1] - h.hours[0])) * HOUR, end = start + (h.dur[0] + r() * (h.dur[1] - h.dur[0])) * MIN;
        const sid = hex(r, 12), model = pick(r, h.models);
        if (start > NOW0 - QUIET) continue;
        for (let t = start; t < Math.min(end, NOW0 - QUIET); t += (1.2 + r() * 3) * MIN * coarse) cands[sub.sub].push({ k: 'u', o: mach.o, t: Math.round(t), sub: sub.sub, p: sub.p, sid, m: model, ...request(r, coarse) });
      }
    }
  });

  // ---- the last hours, by hand: what is going on when the visitor arrives
  const LIVE = [
    { m: 'maya-mbp', s: 'Claude Ultra', model: 'claude-fable-5-2', ago: 47, sid: 'a11ce0000001', every: 2.2 },
    { m: 'maya-mbp', s: 'Claude Ultra', model: 'claude-haiku-5-5', ago: 14, sid: 'a11ce0000005', every: 1.2 },
    { m: 'build-box', s: 'Claude Ultra', model: 'claude-sonnet-5-5', ago: 131, sid: 'a11ce0000002', every: 1.6 },
    { m: 'arjun-desktop', s: 'Claude Ultra', model: 'claude-opus-5-5', ago: 21, sid: 'a11ce0000006', every: 2.5 },
    { m: 'arjun-desktop', s: 'ChatGPT Pro', model: 'gpt-5.4-codex', ago: 26, sid: 'a11ce0000003', every: 2.8, idle: true },
    { m: 'lena-pc', s: 'ChatGPT Plus', model: 'gpt-5.4-mini', ago: 9, sid: 'a11ce0000007', every: 1.4 },
    // ran into the 5-hour limit forty minutes ago
    { m: 'lena-pc', s: 'Claude Pro', model: 'claude-sonnet-5-5', ago: 150, until: 40, sid: 'a11ce0000004', every: 1.5 },
  ];
  const extra = []; // events that are not usage: hellos, labels, prompts, checks, notices
  LIVE.forEach((L, i) => {
    const r = rng(4242 + i), mach = M[L.m], sub = SUB[L.s];
    const start = NOW0 - L.ago * MIN, end = NOW0 - (L.until || 0) * MIN - (L.idle ? 2 * MIN : 20e3);
    extra.push({ k: 'hb', o: mach.o, t: start - 4e3, sub: sub.sub, p: sub.p, sid: L.sid, turn: 1 });
    for (let t = start; t < end; t += (0.5 + r()) * L.every * MIN) cands[sub.sub].push({ k: 'u', o: mach.o, t: Math.round(t), sub: sub.sub, p: sub.p, sid: L.sid, m: L.model, ...request(r) });
    const last = cands[sub.sub][cands[sub.sub].length - 1];
    if (L.idle || L.until) last.end = 1; // the reply finished: idle
    else { last.end = 1; extra.push({ k: 'hb', o: mach.o, t: NOW0 - 8e3, sub: sub.sub, p: sub.p, sid: L.sid, turn: 1 }); } // a new prompt is being answered
  });

  // ---- limits: walk each subscription's requests in order, the way the provider would count them
  const weekEnd = (s, t) => {
    const base = midnight.getTime() + s.anchor[1] * HOUR - ((new Date(NOW0).getDay() - s.anchor[0] + 7) % 7) * DAY; // the latest such weekday, this hour
    return base + (Math.floor((t - base) / WEEK) + 1) * WEEK;
  };
  const pct = (c, b) => Math.min(100, Math.round((c / b) * 100));
  // what a check reads: the 5-hour window (if the plan has one), the week, and Fable's own share of the week
  const reading = (s, st, t, o) => ({
    k: 'hb', o, t, sub: s.sub,
    lim: [...(s.no5 ? [] : [{ m: 300, u: pct(st.c5, st.b5), r: st.r5 }]), { m: 10080, u: pct(st.cw, st.bw), r: st.rw }, ...(s.tf ? [{ m: 10080, k: 'fable', u: pct(st.cf, st.bf), r: st.rw }] : [])],
    ...(s.bank ? { bank: s.bank } : {}),
  });
  // moves the windows on to time t
  const roll = (s, st, t) => { while (t >= st.rw) { st.rw += WEEK; st.cw = 0; st.cf = 0; } };
  // counts one request; false when a limit is used up and the request never happened
  function take(s, st, ev) {
    roll(s, st, ev.t);
    if (!s.no5 && ev.t >= st.r5) { st.r5 = Math.floor(ev.t / MIN) * MIN + 5 * HOUR; st.c5 = 0; }
    const fable = /fable/.test(ev.m);
    if ((!s.no5 && st.c5 >= st.b5) || st.cw >= st.bw || (fable && st.cf >= st.bf)) return false;
    const c = costOf(ev);
    st.c5 += c; st.cw += c;
    if (fable) st.cf += c;
    return true;
  }
  // b: the budgets { b5, bw, bf }
  function walk(s, list, b, checkTimes) {
    const st = { ...b, c5: 0, cw: 0, cf: 0, r5: 0, rw: weekEnd(s, list.length ? list[0].t : NOW0) }, used = [], checks = [];
    let ci = 0, seen = '', turn = 0;
    const check = (t) => {
      roll(s, st, t);
      const around = s.readers.filter((m) => t > NOW0 - M[m].first * DAY); // a machine checks only once it exists
      if (!around.length) return;
      const ev = reading(s, st, t, M[around[turn % around.length]].o), key = JSON.stringify(ev.lim);
      if (key !== seen || t > NOW0 - 20 * MIN) { checks.push(ev); turn++; seen = key; } // nothing new, nothing kept (except the latest)
    };
    for (const ev of list) {
      while (checkTimes && ci < checkTimes.length && checkTimes[ci] < ev.t) check(checkTimes[ci++]);
      if (take(s, st, ev)) used.push(ev);
    }
    while (checkTimes && ci < checkTimes.length) check(checkTimes[ci++]);
    roll(s, st, NOW0);
    return { st, used, checks };
  }
  const events = [];
  const state = {};
  for (const s of SUBS) {
    const list = cands[s.sub].sort((a, b) => a.t - b.t);
    // first without limits, to see what this week and this window cost; the budgets follow from the targets
    const free = walk(s, list, { b5: Infinity, bw: Infinity, bf: Infinity }).st;
    const bw = free.cw > 0 ? free.cw / s.tw : 100, b5 = s.t5 && free.r5 > NOW0 && free.c5 > 0 ? free.c5 / s.t5 : s.b5;
    const bf = s.tf && free.cf > 0 ? free.cf / s.tf : Infinity;
    // earlier weeks end at different levels, well short of the limit more often than not
    const weekCost = new Map();
    for (const ev of list) weekCost.set(weekEnd(s, ev.t), (weekCost.get(weekEnd(s, ev.t)) || 0) + costOf(ev));
    for (const ev of list) {
      const k = weekEnd(s, ev.t);
      if (k > NOW0) continue;
      const f = (bw * (0.42 + 0.5 * rng(Math.round(k / HOUR) % 1e9)())) / weekCost.get(k);
      if (f < 1) for (const key of ['in', 'cr', 'cw', 'out']) ev[key] = Math.round(ev[key] * f);
    }
    // checks: every ten minutes over the days the chart shows by the hour, every minute lately
    const times = [];
    for (let t = NOW0 - 90 * DAY; t < NOW0 - 8 * DAY; t += 3 * HOUR) times.push(t); // enough to know each past week
    for (let t = NOW0 - 8 * DAY; t < NOW0 - 20 * MIN; t += 10 * MIN) times.push(t);
    for (let t = NOW0 - 20 * MIN; t < NOW0 - 30e3; t += s.p === 'codex' ? 3 * MIN : MIN) times.push(t);
    const done = walk(s, list, { b5, bw, bf }, times);
    state[s.sub] = done.st;
    events.push(...done.used, ...done.checks);
  }
  // checks that failed: one machine is signed out, one lost its connection for a moment
  const pro = SUB['Claude Pro'], max = SUB['Claude Ultra'];
  for (const ago of [58, 33, 11]) extra.push({ k: 'hb', o: M['arjun-laptop'].o, t: NOW0 - ago * MIN, sub: pro.sub, le: 'login' });
  extra.push({ k: 'hb', o: M['build-box'].o, t: NOW0 - 14.5 * MIN, sub: max.sub, le: 'net', ra: NOW0 - 12.5 * MIN });

  for (const m of MACH) {
    extra.push({ k: 'hello', o: m.o, t: NOW0 - m.first * DAY, nick: m.nick, host: m.nick, os: m.os, op: m.op, ver: m.ver });
    if (m.gone) extra.push({ k: 'bye', o: m.o, t: NOW0 - m.gone * DAY + 5 * HOUR });
    else extra.push({ k: 'hb', o: m.o, t: NOW0 - 20e3 });
  }
  for (const h of HABITS) extra.push({ k: 'sub', o: M[h.m].o, t: NOW0 - M[h.m].first * DAY + 1, sub: SUB[h.s].sub, label: h.s, p: SUB[h.s].p });
  extra.push({ k: 'ann', o: M['build-box'].o, t: NOW0 - 125 * MIN, msg: 'Schema migration on Ultra, about three more hours', heavy: true, until: NOW0 + 3 * HOUR });
  // the palette would hand maya-mbp Claude's own orange; give it a colour of its own
  extra.push({ k: 'color', o: M['maya-mbp'].o, t: NOW0 - 80 * DAY, mach: 'maya-mbp', c: '#2dd4bf' });
  events.push(...extra);

  // ---- keep it moving: the live sessions go on working, the machines go on checking
  const listeners = new Set();
  const changed = () => listeners.forEach((es) => es.emit('change'));
  const live = LIVE.filter((L) => !L.until).map((L, i) => ({ ...L, r: rng(99 + i), mach: M[L.m], sub: SUB[L.s], busy: !L.idle, turnEnds: NOW0 + (40 + i * 25) * 1e3, next: NOW0 + (L.idle ? 150 : 6 + i * 3) * 1e3 }));
  let checkTurn = 0, lastCheck = NOW0, lastBeat = NOW0;
  setInterval(() => {
    const now = Date.now();
    let any = false;
    for (const L of live) {
      if (now < L.next) continue;
      const base = { o: L.mach.o, sub: L.sub.sub, p: L.sub.p, sid: L.sid };
      if (!L.busy) { // a new prompt
        events.push({ k: 'hb', t: now, turn: 1, ...base });
        L.busy = true; L.turnEnds = now + (25 + L.r() * 70) * 1e3; L.next = now + (5 + L.r() * 8) * 1e3; any = true;
        continue;
      }
      const ev = { k: 'u', t: now, m: L.model, ...base, ...request(L.r, 0.12) };
      const over = now >= L.turnEnds;
      if (over) ev.end = 1;
      if (take(L.sub, state[L.sub.sub], ev)) events.push(ev);
      any = true;
      L.busy = !over;
      L.next = now + (over ? (L.idle ? 90 + L.r() * 120 : 8 + L.r() * 14) : 5 + L.r() * 9) * 1e3;
    }
    if (now - lastBeat > MIN) { lastBeat = now; for (const m of MACH) if (!m.gone) events.push({ k: 'hb', o: m.o, t: now }); any = true; }
    if (now - lastCheck > 45e3) { // machines take turns reading the limits
      lastCheck = now; checkTurn++;
      for (const s of SUBS) {
        roll(s, state[s.sub], now);
        if (s.label === 'Claude Pro' && checkTurn % 2) events.push({ k: 'hb', o: M['arjun-laptop'].o, t: now, sub: s.sub, le: 'login' });
        else events.push(reading(s, state[s.sub], now, M[s.readers[s.label === 'Claude Pro' ? 0 : checkTurn % s.readers.length]].o));
      }
      any = true;
    }
    if (any) changed();
  }, 2000);

  // ---- what the page asks the daemon for
  const self = { nodeId: M['maya-mbp'].o, nick: 'maya-mbp' };
  const TITLES = { a11ce0000005: ['Summarise the failing test logs', 'storefront', 'fix/checkout-flake', 'low', 'claude-vscode'], a11ce0000001: ['Fix flaky checkout tests', 'storefront', 'fix/checkout-flake', 'high', 'claude-vscode'], a11ce0000002: ['Migrate billing tables to v3', 'billing-api', 'chore/schema-v3', 'medium', 'cli'] };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    if (url.pathname === '/api/summary') return json({ self, ...summarize(events, Object.fromEntries(url.searchParams)) });
    if (url.pathname === '/api/session') {
      const sid = url.searchParams.get('sid'), t = TITLES[sid], s = LIVE.find((L) => L.sid === sid);
      return t ? json({ id: `${sid.slice(0, 8)}-4d2a-4b6e-9f10-${sid}`, title: t[0], project: t[1], branch: t[2], effort: t[3], via: t[4], start: NOW0 - s.ago * MIN }) : json({ error: 'not on this machine' }, 404);
    }
    if (url.pathname === '/api/color') {
      const b = JSON.parse((init && init.body) || '{}');
      events.push({ k: 'color', o: self.nodeId, t: Date.now(), mach: b.machine, c: b.color });
      return json({ ok: true });
    }
    return json({ error: 'not in the demo' }, 404);
  };
  window.EventSource = class {
    constructor() { this.on = {}; listeners.add(this); setTimeout(() => this.emit('open'), 0); }
    addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); }
    emit(type) { (this.on[type] || []).forEach((fn) => fn({ type })); }
    close() { listeners.delete(this); }
  };

  // ---- say that it is a demo
  addEventListener('DOMContentLoaded', () => {
    const el = document.createElement('div');
    el.className = 'demo-note';
    el.innerHTML = '<b>Demo</b><span>Made-up team and numbers, moving on their own</span>/*REPO*/';
    document.body.appendChild(el);
  });
})();
