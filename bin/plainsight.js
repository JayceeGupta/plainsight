#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { paths, loadConfig, writeJSON, VERSION, SERVICE } = require('../src/util');

const HELP = `plainsight ${VERSION}: share AI coding usage across your machines, peer to peer.

Setup
  discover [--json]                 List Claude Code / Codex installs and their logged-in accounts
  init --nick NAME [--operator WHO] --track "PROVIDER|DIR|LABEL|SINCE" [--track ...]
                                    Create/replace this machine's config. SINCE (ISO date) optional:
                                    usage before it is ignored. Repeat --track per subscription.
  install                           Background service + Claude/Codex hooks, MCP, skill; start daemon
  uninstall [--purge]               Remove service and integrations (--purge also deletes data)

Run
  daemon                            Run in the foreground (the service runs this)
  ensure                            Start the daemon if it is not running (used by hooks)
  stop | restart                    Stop / restart the daemon
  status [--json]                   Daemon, Tailscale, peers, sync and tracked subscriptions
  doctor                            Check everything and explain what is wrong
  url                               Print dashboard URLs
  announce "MESSAGE" [--hours N] [--light]
                                    Tell all machines this one is starting heavy work
  color MACHINE #rrggbb             Set a machine's dashboard colour everywhere
  dns NAME --token-file F --service-ip IP | dns off
                                    Keep a Cloudflare A record on whichever dashboard host is up (owner machine)
  label SUB "NEW LABEL"             Rename a subscription (by id or current label) everywhere
  mcp                               MCP server on stdio (registered by install)
  update                            git pull + restart

Tailnet owner (once per pool)
  pool bootstrap --token-file F [--admin-ip IP] [--apply] [--force]
                                    Isolate tag:plainsight, define svc:plainsight via the Tailscale API
  pool key --token-file F [--out FILE] [--days 90]
                                    Mint a reusable, ephemeral, pre-approved tag:plainsight auth key
  pool key --viewer --token-file F [--out FILE] [--days 30]
                                    Mint a single-use tag:plainsight-viewer key for one view-only device
  pool viewer DEVICE --token-file F Make an existing device (name or Tailscale IP) view-only

Data: ${paths.home}   Docs: https://github.com/JayceeGupta/plainsight`;

function args(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      const val = v !== undefined ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
      if (k === 'track') (opt.track = opt.track || []).push(val);
      else opt[k] = val;
    } else pos.push(a);
  }
  return { pos, opt };
}

function die(msg) { console.error(`error: ${msg}`); process.exit(1); }

function local(method, p, body) {
  const cfg = loadConfig() || die('not initialised (run plainsight init)');
  const data = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = require('http').request({ host: '127.0.0.1', port: cfg.webPort, method, path: p, timeout: 5000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(s)) : reject(new Error(`HTTP ${res.statusCode} ${s}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(new Error(`daemon not reachable (${e.message}); run: plainsight ensure`)));
    req.end(data);
  });
}

async function cmdInit(opt) {
  const { discover } = require('../src/discover');
  if (!opt.nick || opt.nick === true) die('--nick is required (a short name everyone will recognise, e.g. "gpu-box-1")');
  if (!opt.track || !opt.track.length) die('at least one --track "PROVIDER|DIR|LABEL|SINCE" is required (see: plainsight discover)');
  const found = discover();
  const tracked = [];
  for (const spec of opt.track) {
    const [provider, dir, label, since] = String(spec).split('|');
    if (!['claude', 'codex'].includes(provider)) die(`bad provider in "${spec}" (claude or codex)`);
    const inst = found.find((f) => f.provider === provider && path.resolve(f.dir) === path.resolve(dir || ''));
    if (!inst) die(`no ${provider} install at "${dir}". Run plainsight discover to see what exists.`);
    if (!inst.sub) die(`${provider} at ${dir} is not logged in; log in first, then re-run init.`);
    if (since && !Number.isFinite(Date.parse(since))) die(`bad SINCE date "${since}" (use ISO, e.g. 2026-03-29)`);
    if (tracked.some((t) => t.sub === inst.sub)) die(`${dir} is the same account as another --track; track it once.`);
    tracked.push({ provider, dir: path.resolve(dir), sub: inst.sub, label: (label || `${provider} ${inst.sub.slice(0, 6)}`).slice(0, 60), since: since ? new Date(since).toISOString() : null });
  }
  const prev = loadConfig() || {};
  const cfg = {
    nodeId: prev.nodeId || crypto.randomBytes(8).toString('hex'),
    nickname: String(opt.nick).slice(0, 40),
    operator: opt.operator && opt.operator !== true ? String(opt.operator).slice(0, 40) : (prev.operator || ''),
    port: Number(opt.port) || prev.port || 4747,
    webPort: Number(opt['web-port']) || prev.webPort || 4748,
    hostService: opt['no-host-service'] ? false : prev.hostService !== false,
    tracked,
    createdAt: prev.createdAt || Date.now(),
  };
  writeJSON(paths.config, cfg);
  console.log(`Saved ${paths.config}`);
  for (const t of tracked) console.log(`  tracking ${t.provider} "${t.label}" (subscription ${t.sub}) from ${t.dir}${t.since ? `, usage since ${t.since.slice(0, 10)}` : ', all history'}`);
  console.log('Next: plainsight install');
}

async function cmdStatus(opt) {
  const cfg = loadConfig() || die('not initialised');
  const { health } = require('../src/install');
  const { status } = require('../src/sync');
  const h = await health(cfg.webPort);
  let ts = null;
  try { ts = await status(); } catch (e) { ts = { error: e.message }; }
  if (opt.json) return console.log(JSON.stringify({ config: cfg, daemon: h, tailscale: ts }, null, 2));
  console.log(`plainsight ${VERSION}  node ${cfg.nodeId}  "${cfg.nickname}"${cfg.operator ? ` (${cfg.operator})` : ''}`);
  console.log(`daemon: ${h ? `running, dashboard http://127.0.0.1:${cfg.webPort}` : 'NOT running (plainsight ensure)'}`);
  if (ts.error) console.log(`tailscale: ${ts.error}`);
  else console.log(`tailscale: ${ts.backend}, ${ts.selfIp || 'no IP'}, ${ts.tagged ? 'tagged tag:plainsight (box)' : 'untagged (dials out only)'}; peers online: ${ts.peers.map((p) => p.name).join(', ') || 'none'}`);
  if (h) {
    for (const [name, r] of Object.entries(h.sync || {})) console.log(`  sync ${name}: ${r.ok ? `ok ${new Date(r.at).toLocaleTimeString()}` : `FAILED ${r.error}`}`);
    const total = Object.values(h.events).reduce((a, b) => a + b, 0);
    console.log(`events: ${total} from ${Object.keys(h.events).length} machines (own: ${h.events[cfg.nodeId] || 0})`);
  }
  for (const t of cfg.tracked) console.log(`tracking ${t.provider} "${t.label}" ${t.sub} ${t.dir}${t.since ? ` since ${t.since.slice(0, 10)}` : ''}`);
}

async function cmdDoctor() {
  const ok = (m) => console.log(`  OK   ${m}`);
  const bad = (m, fix) => console.log(`  FAIL ${m}\n       fix: ${fix}`);
  const [maj, min] = process.versions.node.split('.').map(Number);
  (maj > 18 || (maj === 18 && min >= 17)) ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node}`, 'install Node 18.17+ (20+ recommended)');
  const cfg = loadConfig();
  if (!cfg) return bad('not initialised', 'plainsight discover, then plainsight init ...');
  ok(`config ${paths.config}`);
  const { currentSub } = require('../src/discover');
  for (const t of cfg.tracked) {
    const cur = currentSub(t.provider, t.dir);
    cur === t.sub ? ok(`${t.provider} "${t.label}" logged into the tracked account`) : bad(`${t.provider} at ${t.dir} is ${cur ? 'logged into a DIFFERENT account' : 'not logged in'}`, 'log back into the tracked account, or re-run plainsight init with what you want tracked');
  }
  const { status } = require('../src/sync');
  let ts;
  try { ts = await status(); ok(`tailscale ${ts.backend} ${ts.selfIp}`); } catch (e) { return bad(`tailscale: ${e.message}`, 'install Tailscale and run tailscale up (see docs/JOIN.md)'); }
  if (ts.backend !== 'Running') bad('tailscale not running', 'tailscale up --auth-key=... --advertise-tags=tag:plainsight');
  ts.tagged ? ok('this machine is tagged tag:plainsight (shares + hosts the dashboard)') : console.log('  INFO untagged machine: it syncs by dialing out to boxes; it does not host the dashboard');
  ts.peers.length ? ok(`peers online: ${ts.peers.map((p) => p.name).join(', ')}`) : console.log('  INFO no other plainsight machines online right now (fine for the first one)');
  const { health } = require('../src/install');
  const h = await health(cfg.webPort);
  h ? ok(`daemon running (v${h.version})`) : bad('daemon not running', 'plainsight ensure; logs in ' + paths.daemonLog);
  if (h) for (const [n, r] of Object.entries(h.sync || {})) r.ok ? ok(`sync with ${n}`) : bad(`sync with ${n}: ${r.error}`, 'check that both run the same version and the tailnet policy allows tag:plainsight -> tag:plainsight tcp:4747');
  if (ts.tagged) {
    try {
      const out = await require('../src/sync').tailscale(['serve', 'status', '--json']);
      out.includes(SERVICE) ? ok(`hosting ${SERVICE}`) : bad(`not hosting ${SERVICE}`, 'tailscale set --operator=$USER (Linux), then plainsight restart');
    } catch (e) { bad(`tailscale serve status: ${e.message.split('\n')[0]}`, 'needs Tailscale 1.86+; on Linux: sudo tailscale set --operator=$USER'); }
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = args(rest);
  switch (cmd) {
    case 'discover': {
      const list = require('../src/discover').discover();
      if (opt.json) return console.log(JSON.stringify(list, null, 2));
      if (!list.length) return console.log('No Claude Code (~/.claude) or Codex (~/.codex) installs found.');
      list.forEach((d, i) => {
        console.log(`[${i + 1}] ${d.provider}  ${d.dir}`);
        console.log(`    account: ${d.account ? `${d.account.email || '?'}${d.account.org ? ` (${d.account.org})` : ''}${d.account.plan ? ` plan ${d.account.plan}` : ''}` : 'NOT LOGGED IN'}  subscription id: ${d.sub || '-'}`);
        if (d.account && d.account.subscriptionCreatedAt) console.log(`    subscription started: ${d.account.subscriptionCreatedAt}`);
        console.log(`    logs: ${d.logs.files} files${d.logs.files ? `, ${d.logs.oldest.slice(0, 10)} .. ${d.logs.newest.slice(0, 10)}` : ''}`);
        console.log(`    note: ${d.note}`);
      });
      return;
    }
    case 'init': return cmdInit(opt);
    case 'daemon': return require('../src/daemon').main();
    case 'ensure': {
      try { const r = await require('../src/install').ensure(); if (!opt.quiet) console.log(r.started ? `started daemon (pid ${r.pid})` : r.reason); } catch (e) { if (!opt.quiet) console.error(e.message); }
      return;
    }
    case 'stop': {
      try { await local('POST', '/api/stop'); console.log('stopped'); } catch (e) { console.log(e.message); }
      return;
    }
    case 'restart': {
      try { await local('POST', '/api/stop'); } catch {}
      await new Promise((r) => setTimeout(r, 1500));
      const svc = process.platform === 'linux' ? (() => { try { execFileSync('systemctl', ['--user', 'is-enabled', 'plainsight'], { stdio: 'ignore' }); return true; } catch { return false; } })() : false;
      if (svc) { execFileSync('systemctl', ['--user', 'restart', 'plainsight'], { stdio: 'inherit' }); return console.log('restarted (systemd)'); }
      const r = await require('../src/install').ensure();
      return console.log(r.started ? `restarted (pid ${r.pid})` : r.reason);
    }
    case 'status': return cmdStatus(opt);
    case 'doctor': return cmdDoctor();
    case 'url': {
      const cfg = loadConfig() || die('not initialised');
      console.log(`this machine: http://127.0.0.1:${cfg.webPort}`);
      try {
        const st = await require('../src/sync').status();
        if (st.tailnet) console.log(`tailnet:      https://plainsight.${st.tailnet}  (served by any online box)`);
        if (!st.tagged && st.selfDns && cfg.serveTailnet !== false) console.log(`this machine on the tailnet: https://${st.selfDns}:${Number(cfg.tailnetPort) || cfg.webPort}  (while this machine is on)`);
      } catch {}
      console.log('custom domain: whatever DNS name you pointed at the service TailVIP (docs/TAILNET.md)');
      return;
    }
    case 'announce': {
      const msg = pos.join(' ');
      if (!msg) die('usage: plainsight announce "MESSAGE" [--hours N] [--light]');
      const r = await local('POST', '/api/announce', { msg, hours: Number(opt.hours) || 4, heavy: !opt.light });
      return console.log(`announced until ${new Date(r.until).toLocaleString()}`);
    }
    case 'dns': {
      const cfg = loadConfig() || die('not initialised');
      if (pos[0] === 'off') { delete cfg.dns; writeJSON(paths.config, cfg); return console.log('custom domain follower off (restart: plainsight update or reboot)'); }
      const tf = opt['token-file'];
      if (!pos[0] || !tf || tf === true || !opt['service-ip'] || opt['service-ip'] === true) die('usage: plainsight dns NAME --token-file CLOUDFLARE_TOKEN_FILE --service-ip TAILVIP   |   plainsight dns off');
      const r = await require('../src/dns').lookup(fs.readFileSync(tf, 'utf8').trim(), pos[0]);
      if (r.proxied) die(`${pos[0]} is proxied (orange cloud); set it to DNS only first`);
      cfg.dns = { name: pos[0], zoneId: r.zoneId, recordId: r.recordId, serviceIp: opt['service-ip'], tokenFile: path.resolve(tf) };
      writeJSON(paths.config, cfg);
      return console.log(`${pos[0]} (now ${r.content}) will follow whichever dashboard host is up: the Service ${opt['service-ip']} when a box hosts it, else this machine. Restart the daemon to start: plainsight update`);
    }
    case 'color': {
      if (pos.length < 2 || !/^#?[0-9a-fA-F]{6}$/.test(pos[1])) die('usage: plainsight color MACHINE #rrggbb');
      await local('POST', '/api/color', { machine: pos[0], color: ('#' + pos[1].replace('#', '')).toLowerCase() });
      return console.log(`${pos[0]} is now ${pos[1]} on every dashboard`);
    }
    case 'label': {
      const cfg = loadConfig() || die('not initialised');
      const [who, label] = pos;
      if (!who || !label) die('usage: plainsight label SUB "NEW LABEL"');
      const t = cfg.tracked.find((x) => x.sub === who || x.label === who);
      if (!t) die('that subscription is not tracked on this machine (labels are set by a machine that tracks it)');
      t.label = label.slice(0, 60);
      writeJSON(paths.config, cfg);
      console.log('saved; restarting daemon to publish it');
      try { await local('POST', '/api/stop'); } catch {}
      await new Promise((r) => setTimeout(r, 1500));
      await require('../src/install').ensure();
      return;
    }
    case 'install': {
      const cfg = loadConfig() || die('not initialised (plainsight init first)');
      const inst = require('../src/install');
      for (const line of inst.integrate(cfg)) console.log(`  ${line}`);
      try { console.log(`  ${inst.installService()}`); } catch (e) { console.log(`  service not installed (${e.message.split('\n')[0]}); the SessionStart hook keeps the daemon alive instead`); }
      await new Promise((r) => setTimeout(r, 1500));
      const r = await inst.ensure();
      console.log(`  daemon: ${r.started ? `started (pid ${r.pid})` : r.reason}`);
      console.log('Restart Claude Code / Codex sessions to load the MCP server and skill. Check with: plainsight doctor');
      return;
    }
    case 'uninstall': {
      try { await local('POST', '/api/stop'); } catch {}
      require('../src/install').uninstallService();
      console.log('Service removed. Remove the SessionStart hook ("plainsight ensure") from settings.json and run: claude mcp remove --scope user plainsight ; delete [mcp_servers.plainsight] from ~/.codex/config.toml.');
      if (opt.purge) { fs.rmSync(paths.home, { recursive: true, force: true }); console.log(`deleted ${paths.home}`); }
      return;
    }
    case 'mcp': return require('../src/mcp').serve();
    case 'update': {
      const root = path.resolve(__dirname, '..');
      execFileSync('git', ['-C', root, 'pull', '--ff-only'], { stdio: 'inherit' });
      try { await local('POST', '/api/stop'); } catch {}
      await new Promise((r) => setTimeout(r, 1500));
      const r = await require('../src/install').ensure();
      return console.log(r.started ? 'updated and restarted' : r.reason);
    }
    case 'pool': {
      const pool = require('../src/pool');
      const tf = opt['token-file'];
      if (!tf || tf === true) die('--token-file FILE is required (a Tailscale API access token; never pass the token itself on the command line)');
      const token = fs.readFileSync(tf, 'utf8').trim();
      if (pos[0] === 'bootstrap') {
        const r = await pool.bootstrap(token, { adminIp: opt['admin-ip'] !== true ? opt['admin-ip'] : undefined, apply: !!opt.apply, force: !!opt.force });
        r.out.forEach((l) => console.log(l));
        if (r.addrs && r.addrs.length) console.log(`Optional custom domain: add a DNS A record (DNS only, not proxied) NAME -> ${r.addrs.find((a) => a.includes('.'))}`);
        return;
      }
      if (pos[0] === 'key') {
        const viewer = !!opt.viewer;
        const file = opt.out && opt.out !== true ? opt.out : path.join(paths.home, viewer ? 'tailscale-viewer-key.txt' : 'tailscale-authkey.txt');
        const r = await pool.mintKey(token, file, Number(opt.days) || (viewer ? 30 : 90), viewer);
        return console.log(`Auth key ${r.id} saved to ${r.file} (expires ${r.expires}). It is not printed; hand the file's content ${viewer ? 'to the one view-only device' : 'to new boxes'} privately.`);
      }
      if (pos[0] === 'viewer') {
        if (!pos[1]) die('usage: plainsight pool viewer DEVICE --token-file F');
        const r = await pool.makeViewer(token, pos[1]);
        return console.log(`${r.name} is now tag:plainsight-viewer: it can open the dashboard and nothing else, and nothing can connect to it. Undo: admin console > Machines > ${r.name} > Edit ACL tags.`);
      }
      return die('usage: plainsight pool bootstrap|key|viewer --token-file F');
    }
    case undefined: case 'help': case '--help': case '-h': return console.log(HELP);
    case '--version': case 'version': return console.log(VERSION);
    default: die(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((e) => die(e.message));
