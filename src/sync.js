'use strict';
// Gossip over Tailscale. Peers = online tailnet nodes tagged tag:plainsight.
// One exchange: GET /sync/vv, then POST /sync/exchange {have, give} -> {give}. Repeat until caught up.
const http = require('http');
const net = require('net');
const fs = require('fs');
const { execFile } = require('child_process');
const { TAG, PROTOCOL, VERSION, log } = require('./util');

const BATCH = 5000;

function tailscaleBin() {
  if (process.env.PLAINSIGHT_TAILSCALE) return process.env.PLAINSIGHT_TAILSCALE;
  const mac = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  if (process.platform === 'darwin' && fs.existsSync(mac)) return mac;
  return 'tailscale';
}

function tailscale(args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(tailscaleBin(), args, { timeout, windowsHide: true, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().trim()));
      resolve(stdout.toString());
    });
  });
}

async function status() {
  const j = JSON.parse(await tailscale(['status', '--json']));
  const self = j.Self || {};
  const v4 = (ips) => (ips || []).find((ip) => ip.includes('.'));
  const peers = Object.values(j.Peer || {})
    .filter((p) => p.Online && (p.Tags || []).includes(TAG))
    .map((p) => ({ ip: v4(p.TailscaleIPs), name: p.HostName }))
    .filter((p) => p.ip);
  return {
    backend: j.BackendState,
    selfIp: v4(self.TailscaleIPs),
    selfName: self.HostName,
    selfDns: (self.DNSName || '').replace(/\.$/, ''),
    tagged: (self.Tags || []).includes(TAG),
    tailnet: (j.CurrentTailnet || {}).MagicDNSSuffix || null,
    peers,
  };
}

// Minimal SOCKS5 (no auth) for userspace-networking tailscaled (containers without /dev/net/tun).
function socksConnect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const [ph, pp] = proxy.replace(/^socks5h?:\/\//, '').split(':');
    const s = net.connect(Number(pp), ph);
    let stage = 0;
    s.setTimeout(5000, () => s.destroy(new Error('socks timeout')));
    s.once('error', reject);
    s.once('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', function onData(d) {
      if (stage === 0) {
        if (d[0] !== 5 || d[1] !== 0) return s.destroy(new Error('socks auth refused'));
        stage = 1;
        s.write(Buffer.from([5, 1, 0, 1, ...host.split('.').map(Number), port >> 8, port & 255]));
      } else {
        s.removeListener('data', onData);
        if (d[1] !== 0) return s.destroy(new Error(`socks connect failed (${d[1]})`));
        s.setTimeout(0);
        resolve(s);
      }
    });
  });
}

async function request(ip, port, method, pathname, body) {
  const proxy = process.env.PLAINSIGHT_SOCKS || '';
  const sock = proxy ? await socksConnect(proxy, ip, port) : null;
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: ip, port, method, path: pathname, timeout: 15000,
      ...(sock ? { createConnection: () => sock } : {}),
      headers: { 'content-type': 'application/json', 'x-plainsight': String(PROTOCOL), 'user-agent': `plainsight/${VERSION}`, ...(data ? { 'content-length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 64 << 20) req.destroy(new Error('response too large')); else chunks.push(c); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// What `peerVV` is missing from us.
function giveFor(store, peerVV) {
  const give = {};
  for (const [origin, count] of Object.entries(store.vv())) {
    const have = Number(peerVV[origin]) || 0;
    if (count > have) give[origin] = { from: have + 1, lines: store.linesAfter(origin, have, BATCH) };
  }
  return give;
}

function ingestAll(store, give, selfOrigin) {
  let n = 0;
  for (const [origin, b] of Object.entries(give || {})) {
    if (b && Array.isArray(b.lines)) n += store.ingest(origin, Number(b.from), b.lines, selfOrigin);
  }
  return n;
}

async function exchange(store, selfOrigin, peer, port) {
  let sent = 0, got = 0;
  for (let round = 0; round < 50; round++) {
    const vv = await request(peer.ip, port, 'GET', '/sync/vv');
    if (vv.protocol !== PROTOCOL) throw new Error(`peer protocol ${vv.protocol}, ours ${PROTOCOL}; update plainsight`);
    const give = giveFor(store, vv.vv || {});
    const res = await request(peer.ip, port, 'POST', '/sync/exchange', { have: store.vv(), give });
    const g = ingestAll(store, res.give, selfOrigin);
    const s = Object.values(give).reduce((a, b) => a + b.lines.length, 0);
    sent += s; got += g;
    const full = Object.values(give).some((b) => b.lines.length === BATCH) || Object.values(res.give || {}).some((b) => b.lines.length === BATCH);
    if (!full) break;
  }
  return { sent, got };
}

class Syncer {
  constructor(cfg, store) {
    this.cfg = cfg;
    this.store = store;
    this.running = false;
    this.again = false;
    this.lastPeers = [];
    this.lastResults = {};
    this.ready = false; // true after the first round that reached a peer, or found none to reach
  }

  async run() {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do {
        this.again = false;
        let st;
        try { st = await status(); } catch (e) { log('tailscale status failed:', e.message); return; }
        this.lastPeers = st.peers;
        const others = st.peers.filter((p) => p.ip !== st.selfIp);
        let anyOk = false;
        await Promise.all(others.map(async (p) => {
          try {
            const r = await exchange(this.store, this.cfg.nodeId, p, this.cfg.port);
            this.lastResults[p.name] = { ok: true, at: Date.now(), ...r };
            anyOk = true;
            if (r.sent || r.got) log(`sync ${p.name}: sent ${r.sent}, got ${r.got}`);
          } catch (e) {
            this.lastResults[p.name] = { ok: false, at: Date.now(), error: e.message };
          }
        }));
        if (!others.length || anyOk) this.ready = true;
      } while (this.again);
    } finally { this.running = false; }
  }
}

module.exports = { Syncer, status, tailscale, request, giveFor, ingestAll, BATCH };
