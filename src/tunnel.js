'use strict';
// Runs a Cloudflare Tunnel connector (cloudflared) next to the daemon, so this machine can answer
// for the dashboard hostname. Every machine with the tunnel token runs one; Cloudflare sends each
// visitor to any connector that is up. The connector forwards to the read-only view listener only.
//
// Secrets: the tunnel token (file, never on the command line). It can run this one tunnel and
// nothing else in your Cloudflare account.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { paths, log } = require('./util');

const BIN_DIR = path.join(paths.home, 'bin');
const LOG = path.join(paths.home, 'cloudflared.log');
const RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

function asset() {
  const a = process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm' : 'amd64';
  if (process.platform === 'win32') return { name: 'cloudflared-windows-amd64.exe', file: 'cloudflared.exe' };
  if (process.platform === 'darwin') return { name: `cloudflared-darwin-${a === 'arm64' ? 'arm64' : 'amd64'}.tgz`, file: 'cloudflared', tgz: true };
  if (process.platform === 'linux') return { name: `cloudflared-linux-${a}`, file: 'cloudflared' };
  return null;
}

function onPath() {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().split(/\r?\n/)[0].trim();
    return out || null;
  } catch { return null; }
}

// cfg.cloudflared (explicit path) > cloudflared on PATH > ~/.plainsight/bin (downloaded once)
async function locate(cfg) {
  if (cfg.cloudflared && fs.existsSync(cfg.cloudflared)) return cfg.cloudflared;
  const sys = onPath();
  if (sys) return sys;
  const a = asset();
  if (!a) throw new Error(`no cloudflared build for ${process.platform}-${process.arch}; install it and set "cloudflared" in config`);
  const dest = path.join(BIN_DIR, a.file);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  log(`downloading cloudflared (${a.name}) from GitHub releases`);
  const res = await fetch(RELEASE + a.name, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`download ${a.name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${dest}.download`;
  if (a.tgz) {
    const tgz = `${tmp}.tgz`;
    fs.writeFileSync(tgz, buf);
    execFileSync('tar', ['-xzf', tgz, '-C', BIN_DIR], { stdio: 'ignore' });
    fs.unlinkSync(tgz);
  } else {
    fs.writeFileSync(tmp, buf, { mode: 0o755 });
    fs.renameSync(tmp, dest);
  }
  fs.chmodSync(dest, 0o755);
  return dest;
}

class Tunnel {
  constructor(cfg) {
    this.cfg = cfg;
    this.tokenFile = cfg.tunnelTokenFile || path.join(paths.home, 'tunnel-token');
    this.child = null;
    this.restarts = 0;
    this.lastError = null;
    this.startedAt = 0;
    this.stopping = false;
    this.timer = null;
  }

  configured() { return fs.existsSync(this.tokenFile); }

  status() {
    return { configured: this.configured(), running: !!this.child, pid: this.child ? this.child.pid : null, since: this.startedAt || null, restarts: this.restarts, error: this.lastError };
  }

  async start() {
    if (this.child || this.stopping || !this.configured()) return;
    let token;
    try { token = fs.readFileSync(this.tokenFile, 'utf8').trim(); } catch (e) { this.lastError = e.message; return; }
    if (!token) { this.lastError = 'tunnel token file is empty'; return; }
    let bin;
    try { bin = await locate(this.cfg); } catch (e) { this.lastError = e.message; log(`tunnel: ${e.message}`); return this.retry(); }
    const out = fs.openSync(LOG, fs.existsSync(LOG) && fs.statSync(LOG).size > 5e6 ? 'w' : 'a');
    // token via environment, never argv (argv is visible to every local user)
    const child = spawn(bin, ['tunnel', '--no-autoupdate', 'run'], { env: { ...process.env, TUNNEL_TOKEN: token }, stdio: ['ignore', out, out], windowsHide: true });
    fs.closeSync(out);
    this.child = child;
    this.startedAt = Date.now();
    this.lastError = null;
    log(`tunnel: cloudflared started (pid ${child.pid}); log ${LOG}`);
    child.on('exit', (code, sig) => {
      this.child = null;
      if (this.stopping) return;
      this.lastError = `cloudflared exited (${sig || code}); see ${LOG}`;
      log(`tunnel: ${this.lastError}`);
      this.retry();
    });
    child.on('error', (e) => { this.lastError = e.message; });
  }

  retry() {
    if (this.stopping || this.timer) return;
    this.restarts++;
    const wait = Math.min(300e3, 5e3 * 2 ** Math.min(6, this.restarts));
    this.timer = setTimeout(() => { this.timer = null; this.start(); }, wait);
    this.timer.unref();
  }

  stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.child) { try { this.child.kill(); } catch {} }
  }
}

module.exports = { Tunnel, locate };
