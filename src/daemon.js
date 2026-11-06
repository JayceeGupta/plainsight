'use strict';
// The long-running process: collect local usage, gossip with peers, serve the dashboard.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('./store');
const { Collector } = require('./collect');
const { Syncer, status, tailscale, giveFor, ingestAll } = require('./sync');
const { summarize } = require('./aggregate');
const prices = require('./prices');
const { paths, loadConfig, log, VERSION, PROTOCOL, SERVICE } = require('./util');

const WEB = path.join(__dirname, '..', 'web', 'index.html');

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, code, obj, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(obj) : obj;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

// Control endpoints only for this machine itself, never via the Tailscale Service proxy.
function isLocal(req) {
  const host = String(req.headers.host || '').split(':')[0];
  return (host === '127.0.0.1' || host === 'localhost') && !req.headers['tailscale-user-login'] && !req.headers['x-forwarded-for'];
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
}

async function main() {
  const cfg = loadConfig();
  if (!cfg) { console.error('Not initialised. Run: plainsight init (see README).'); process.exit(1); }
  const store = new Store(paths.logDir);
  const self = cfg.nodeId;
  const collector = new Collector(cfg, store);
  const syncer = new Syncer(cfg, store);
  const sse = new Set();
  let ts = { tagged: false, peers: [] };
  let lastScan = 0;

  // ---- web (dashboard + read API), 127.0.0.1 only; published via Tailscale Service on tagged nodes
  const web = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, fs.readFileSync(WEB), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/summary') {
        const q = Object.fromEntries(url.searchParams);
        return send(res, 200, { self: { nodeId: self, nick: cfg.nickname }, ...summarize(store.all(), q) });
      }
      if (req.method === 'GET' && url.pathname === '/api/live') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        sse.add(res);
        req.on('close', () => sse.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const counts = {};
        for (const [o, l] of store.logs) counts[o] = l.length;
        return send(res, 200, { ok: true, version: VERSION, nodeId: self, nickname: cfg.nickname, tagged: ts.tagged, peers: ts.peers, sync: syncer.lastResults, lastScan, events: counts, tracked: cfg.tracked.map((t) => ({ provider: t.provider, label: t.label, sub: t.sub, dir: t.dir, since: t.since })) });
      }
      if (req.method === 'POST' && url.pathname === '/api/announce') {
        if (!isLocal(req)) return send(res, 403, { error: 'local only' });
        const b = await readBody(req, 4096);
        const hours = Math.min(72, Math.max(0.1, Number(b.hours) || 4));
        const msg = String(b.msg || b.message || 'heavy task').slice(0, 200);
        const [ev] = store.appendLocal(self, [{ k: 'ann', msg, heavy: b.heavy !== false, hours, until: Date.now() + hours * 3600e3 }]);
        return send(res, 200, { ok: true, until: ev.until });
      }
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        if (!isLocal(req)) return send(res, 403, { error: 'local only' });
        send(res, 200, { ok: true });
        return shutdown();
      }
      if (req.method === 'POST' && url.pathname === '/api/poke') {
        if (!isLocal(req)) return send(res, 403, { error: 'local only' });
        await scan();
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });
  try {
    await listen(web, cfg.webPort, '127.0.0.1');
  } catch (e) {
    if (e.code === 'EADDRINUSE') { log(`port ${cfg.webPort} in use: daemon already running`); process.exit(0); }
    throw e;
  }
  fs.writeFileSync(paths.pid, String(process.pid));
  log(`plainsight ${VERSION} node ${self} (${cfg.nickname}) dashboard http://127.0.0.1:${cfg.webPort}`);

  // ---- sync server: tagged nodes only. Untagged nodes (e.g. an admin PC) only dial out.
  const syncServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/sync/vv') return send(res, 200, { protocol: PROTOCOL, version: VERSION, vv: store.vv() });
      if (req.method === 'POST' && url.pathname === '/sync/exchange') {
        if (String(req.headers['x-plainsight']) !== String(PROTOCOL)) return send(res, 409, { error: 'protocol mismatch' });
        const b = await readBody(req, 64 << 20);
        ingestAll(store, b.give, self);
        return send(res, 200, { give: giveFor(store, b.have || {}) });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  });

  async function refreshTailscale() {
    try {
      const st = await status();
      const becameTagged = st.tagged && !ts.tagged;
      ts = st;
      if (!st.tagged && st.backend === 'Running' && cfg.serveTailnet !== false) await serveOnTailnet(st);
      if (becameTagged) {
        // Userspace-networking tailscaled delivers inbound connections to 127.0.0.1.
        for (const host of [st.selfIp, '127.0.0.1']) {
          if (!host) continue;
          const srv = host === '127.0.0.1' ? syncServer : http.createServer(syncServer.listeners('request')[0]);
          try { await listen(srv, cfg.port, host); log(`sync listening ${host}:${cfg.port}`); } catch (e) { log(`sync listen ${host}:${cfg.port} failed: ${e.message}`); }
        }
        if (cfg.hostService !== false) {
          for (const flag of [`--https=443`, `--http=80`]) {
            try { await tailscale(['serve', `--service=${SERVICE}`, flag, `127.0.0.1:${cfg.webPort}`], 20000); }
            catch (e) { log(`tailscale serve ${flag} failed (dashboard service not hosted here): ${e.message}`); }
          }
        }
      }
    } catch (e) {
      log('tailscale not available:', e.message);
    }
  }

  // Untagged machines (your own computer) publish the dashboard on their own tailnet name so your
  // other devices (phone) can open it even when no box is online. Read-only: the proxy adds
  // Tailscale-User-Login / X-Forwarded-For, so isLocal() refuses every POST from it.
  let served = false;
  async function serveOnTailnet(st) {
    if (served) return;
    const port = Number(cfg.tailnetPort) || cfg.webPort;
    const target = `http://127.0.0.1:${cfg.webPort}`;
    try {
      const cur = JSON.parse((await tailscale(['serve', 'status', '--json'])) || '{}');
      const used = Object.entries(cur.Web || {}).find(([hp]) => hp.endsWith(`:${port}`));
      const mine = used && Object.values(used[1].Handlers || {}).some((h) => h.Proxy === target);
      if (used && !mine) { served = true; return log(`tailnet port ${port} already serves something else; dashboard not published there (set tailnetPort in config)`); }
      if ((cur.AllowFunnel || {})[`${st.selfDns}:${port}`]) { served = true; return log(`port ${port} is public via Funnel; refusing to publish the dashboard there`); }
      if (!mine) await tailscale(['serve', '--bg', `--https=${port}`, target], 20000);
      served = true;
      log(`dashboard on the tailnet: https://${st.selfDns || st.selfIp}:${port}`);
    } catch (e) {
      served = true;
      log(`tailscale serve failed (dashboard only on this machine): ${e.message}`);
    }
  }

  // ---- events
  const startEvents = [{ k: 'hello', nick: cfg.nickname, host: os.hostname().slice(0, 100), os: `${process.platform}-${process.arch}`, op: cfg.operator || '', ver: VERSION }];
  for (const t of cfg.tracked) startEvents.push({ k: 'sub', sub: t.sub, p: t.provider, label: t.label });
  store.appendLocal(self, startEvents);

  let pushTimer = null;
  let sseTimer = null;
  store.on('change', (c) => {
    if (c.local && !pushTimer) pushTimer = setTimeout(() => { pushTimer = null; syncer.run(); }, 2000);
    if (!sseTimer) sseTimer = setTimeout(() => {
      sseTimer = null;
      for (const r of sse) r.write(`event: change\ndata: ${Date.now()}\n\n`);
    }, 1000);
  });

  async function scan() {
    try { await collector.scan(); lastScan = Date.now(); } catch (e) { log('scan error:', e.message); }
  }

  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    try { store.appendLocal(self, [{ k: 'bye' }]); } catch {}
    syncer.run().finally(() => {
      try { fs.unlinkSync(paths.pid); } catch {}
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await refreshTailscale();
  prices.refresh();
  await scan(); // first run = backfill
  syncer.run();

  setInterval(scan, 5000);
  setInterval(() => { refreshTailscale().then(() => syncer.run()); }, 60e3);
  setInterval(() => store.appendLocal(self, [{ k: 'hb' }]), 120e3);
  setInterval(() => prices.refresh(), 6 * 3600e3);
  setInterval(() => { for (const r of sse) r.write(': ping\n\n'); }, 25e3);
}

module.exports = { main, isLocal };
