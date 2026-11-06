#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { paths, loadConfig, writeJSON, VERSION } = require('../src/util');

const HELP = `plainsight ${VERSION}: share AI coding usage across your machines, peer to peer.

Setup
  discover [--json]                 List Claude Code / Codex installs and their logged-in accounts
  init --nick NAME [--operator WHO] --track "PROVIDER|DIR|LABEL|SINCE" [--track ...]
                                    Create/replace this machine's config. SINCE (ISO date) optional:
                                    usage before it is ignored. Repeat --track per subscription.
  install                           Background service + Claude/Codex hooks, MCP, skill; start daemon
  uninstall [--purge [--yes]]       Remove service, hook, MCP, skill, command and tunnel token
                                    (--purge also deletes ~/.plainsight: data, code, ids, backups)

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
  label SUB "NEW LABEL"             Rename a subscription (by id or current label) everywhere
  mcp                               MCP server on stdio (registered by install)
  update                            git pull, refresh skills/hook/MCP/command, restart

Dashboard tunnel (every machine that should be able to show the dashboard)
  tunnel join --token-file F        Store the tunnel token (from the owner) and join the dashboard tunnel
  tunnel leave                      Stop serving the dashboard from this machine and delete the token
  tunnel status                     Is this machine's connector running?

Tailnet owner (once per pool): data sharing
  pool bootstrap --token-file F [--apply] [--force]
                                    Isolate boxes (tag:plainsight) via the Tailscale API: boxes sync
                                    with each other, your own devices connect out to them
  pool key --token-file F [--out FILE] [--days 90] [--ephemeral]
                                    Mint a reusable, pre-approved tag:plainsight auth key for boxes
                                    (--ephemeral only for throwaway CI/containers)

Cloudflare owner (once): the dashboard at https://HOSTNAME behind a login
  cloudflare setup --hostname H [--email E[,E..]] [--domain D] [--session 720h]
                   [--google-client-id ID --google-secret-file F] [--account ID]
                                    Tunnel + DNS + Access login + "no machine online" Worker.
                                    Saves the tunnel token on this machine. Safe to re-run.
  cloudflare status                 URL, login methods, allowed emails, connected machines
  cloudflare tunnel-token [--out F] Write the tunnel token to a file, to hand to a new box
  cloudflare teardown --yes         Remove everything setup created (tunnel, DNS, app, Worker)

Who can sign in (owner; changes apply within seconds)
  access list                       Allowed emails and email domains
  access add EMAIL [EMAIL..]        Allow these addresses
  access remove EMAIL [EMAIL..]     Disallow, and sign them out everywhere now
  access allow-domain DOMAIN        Allow every address @DOMAIN (refuses public providers like gmail.com)
  access remove-domain DOMAIN
  access login google|code|both     Which sign-in options the login page offers
  access google --client-id ID --client-secret-file F
                                    Add or replace "Sign in with Google"
  access session DURATION           How long a sign-in lasts, e.g. 24h, 168h, 720h
  access revoke [EMAIL]             Sign out one person, or everyone, immediately
  Cloudflare commands need an API token: --token-file F or CLOUDFLARE_API_TOKEN. plainsight never
  stores it; create one when needed and revoke it after (docs/DASHBOARD.md lists the permissions).

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
    port: (() => {
      const p = Number(opt.port) || prev.port || 4747;
      if (p !== 4747) console.log(`WARNING: sync port ${p}: the tailnet policy written by "plainsight pool bootstrap" only opens tcp:4747, so every machine must use the same port and the policy must be edited to match.`);
      return p;
    })(),
    webPort: Number(opt['web-port']) || prev.webPort || 4748,
    tracked,
    createdAt: prev.createdAt || Date.now(),
    // dashboard settings survive a re-init
    ...(prev.viewPort ? { viewPort: prev.viewPort } : {}),
    ...(prev.cloudflare ? { cloudflare: prev.cloudflare } : {}),
    ...(prev.tunnelTokenFile ? { tunnelTokenFile: prev.tunnelTokenFile } : {}),
    ...(prev.cloudflared ? { cloudflared: prev.cloudflared } : {}),
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
  if (h && h.tunnel) console.log(`dashboard tunnel: ${!h.tunnel.configured ? 'not joined (plainsight tunnel join)' : h.tunnel.running ? `connected (pid ${h.tunnel.pid})` : `not running${h.tunnel.error ? ': ' + h.tunnel.error : h.tailscaleError ? ' (Tailscale unavailable: '+ h.tailscaleError + ')' : h.synced ? '' : ' (waiting for first sync)'}`}`);
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
  maj >= 20 ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node}`, 'install Node 20 or newer (https://nodejs.org)');
  const cfg = loadConfig();
  if (!cfg) return bad('not initialised', 'plainsight discover, then plainsight init ...');
  ok(`config ${paths.config}`);
  const { currentSub } = require('../src/discover');
  for (const t of cfg.tracked) {
    const cur = currentSub(t.provider, t.dir);
    cur === t.sub ? ok(`${t.provider} "${t.label}" logged into the tracked account`) : bad(`${t.provider} at ${t.dir} is ${cur ? 'logged into a DIFFERENT account' : 'not logged in'}`, 'log back into the tracked account, or re-run plainsight init with what you want tracked');
  }
  const { status } = require('../src/sync');
  let ts = null;
  try { ts = await status(); ok(`tailscale ${ts.backend} ${ts.selfIp || ''}`); } catch (e) { bad(`tailscale: ${e.message.split('\n')[0]}`, 'install Tailscale and sign in (see docs/JOIN.md); sharing pauses until it works, the local dashboard keeps going'); }
  if (ts) {
    if (ts.backend !== 'Running') bad(`tailscale is ${ts.backend}`, ts.tagged ? 'tailscale up' : 'open Tailscale and sign in (on a box: tailscale up --auth-key=file:KEYFILE --advertise-tags=tag:plainsight)');
    ts.tagged ? ok('this machine is a box (tagged tag:plainsight): other boxes and your devices sync with it') : console.log('  INFO personal machine (untagged): it syncs by connecting out to boxes; at least one box must exist for anything to sync');
    ts.peers.length ? ok(`boxes online: ${ts.peers.map((p) => p.name).join(', ')}`) : console.log('  INFO no box online right now (nothing to sync with until one is)');
  }
  const { health } = require('../src/install');
  const h = await health(cfg.webPort);
  h ? ok(`daemon running (v${h.version})`) : bad('daemon not running', 'plainsight ensure; logs in ' + paths.daemonLog);
  if (h) for (const [n, r] of Object.entries(h.sync || {})) r.ok ? ok(`sync with ${n}`) : bad(`sync with ${n}: ${r.error}`, `both must run the same plainsight version, and the tailnet policy must allow ${ts && ts.tagged ? 'tag:plainsight -> tag:plainsight' : 'your devices (autogroup:member) -> tag:plainsight'} on tcp:4747 (re-run plainsight pool bootstrap)`);
  if (h && h.tunnel) {
    if (!h.tunnel.configured) console.log('  INFO not in the dashboard tunnel: this machine does not show the dashboard to others (plainsight tunnel join)');
    else if (h.tunnel.running) ok('dashboard tunnel connector running');
    else bad(`dashboard tunnel not running${h.tunnel.error ? ': ' + h.tunnel.error : h.tailscaleError ? ' (Tailscale is unavailable, so this machine cannot sync first)' : h.synced ? '' : ' (waiting for the first sync with a box)'}`, `see ${path.join(paths.home, 'cloudflared.log')}; plainsight restart`);
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
    case 'stop': return console.log(await require('../src/install').stop());
    case 'restart': return console.log(await require('../src/install').restart());
    case 'status': return cmdStatus(opt);
    case 'doctor': return cmdDoctor();
    case 'url': {
      const cfg = loadConfig() || die('not initialised');
      console.log(`this machine: http://127.0.0.1:${cfg.webPort}`);
      console.log(`everywhere:   ${cfg.cloudflare ? `https://${cfg.cloudflare.hostname}` : 'the hostname you set up with plainsight cloudflare setup (docs/DASHBOARD.md)'}  (sign-in required; served by any machine in the tunnel)`);
      return;
    }
    case 'announce': {
      const msg = pos.join(' ');
      if (!msg) die('usage: plainsight announce "MESSAGE" [--hours N] [--light]');
      const r = await local('POST', '/api/announce', { msg, hours: Number(opt.hours) || 4, heavy: !opt.light });
      return console.log(`announced until ${new Date(r.until).toLocaleString()}`);
    }
    case 'tunnel': {
      const tokenFile = (loadConfig() || {}).tunnelTokenFile || path.join(paths.home, 'tunnel-token');
      if (pos[0] === 'join') {
        if (!loadConfig()) die('set up plainsight on this machine first (plainsight init ..., then plainsight install), then join the tunnel');
        const tf = opt['token-file'];
        if (!tf || tf === true) die('usage: plainsight tunnel join --token-file FILE   (the tunnel token from the owner; never paste it on the command line)');
        const tok = fs.readFileSync(tf, 'utf8').trim();
        if (!/^[A-Za-z0-9+/=_-]{40,}$/.test(tok)) die('that file does not look like a Cloudflare tunnel token');
        fs.mkdirSync(paths.home, { recursive: true });
        fs.writeFileSync(tokenFile, tok + '\n', { mode: 0o600 });
        try { fs.chmodSync(tokenFile, 0o600); } catch {}
        console.log(await require('../src/install').restart());
        return console.log(`Tunnel token stored in ${tokenFile}. The daemon joins the dashboard tunnel after its first sync (check: plainsight tunnel status). You can delete ${tf} now.`);
      }
      if (pos[0] === 'leave') {
        try { fs.unlinkSync(tokenFile); } catch {}
        if (loadConfig()) await require('../src/install').restart();
        return console.log('Left the dashboard tunnel and deleted the token. This machine still shares usage.');
      }
      if (pos[0] === 'status' || !pos[0]) {
        const cfg = loadConfig() || die('not initialised');
        const h = await require('../src/install').health(cfg.webPort);
        if (!h) return console.log('daemon not running');
        return console.log(JSON.stringify({ ...h.tunnel, synced: h.synced, tailscaleError: h.tailscaleError || null }, null, 2));
      }
      return die('usage: plainsight tunnel join|leave|status');
    }
    case 'cloudflare': case 'access': {
      const cf = require('../src/cloudflare');
      const cfg = loadConfig() || die('not initialised');
      const token = cf.readToken(opt);
      const list = (v) => (v && v !== true ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);
      if (cmd === 'cloudflare' && pos[0] === 'setup') {
        const hostname = opt.hostname && opt.hostname !== true ? opt.hostname : (cfg.cloudflare || {}).hostname;
        if (!hostname) die('usage: plainsight cloudflare setup --hostname usage.example.com [--email you@example.com]');
        const google = opt['google-client-id'] && opt['google-client-id'] !== true
          ? { clientId: opt['google-client-id'], secretFile: opt['google-secret-file'] || die('--google-secret-file FILE is required with --google-client-id') } : null;
        const r = await cf.setup(token, {
          hostname, emails: list(opt.email), domains: list(opt.domain), session: opt.session && opt.session !== true ? opt.session : null,
          account: opt.account !== true ? opt.account : undefined, viewPort: Number(cfg.viewPort) || cfg.webPort + 1,
          tunnelTokenFile: cfg.tunnelTokenFile || path.join(paths.home, 'tunnel-token'), google, prev: cfg.cloudflare, allowPublicDomain: !!opt['i-understand'],
        });
        cfg.cloudflare = r.conf;
        writeJSON(paths.config, cfg);
        r.out.forEach((l) => console.log(l));
        console.log(await require('../src/install').restart());
        return console.log(`Done. Open https://${hostname} (this machine joins the tunnel after its first sync).`);
      }
      const c = cfg.cloudflare || die('run plainsight cloudflare setup first (on the machine that set it up, or copy the "cloudflare" block of its config)');
      if (cmd === 'cloudflare') {
        if (pos[0] === 'status') {
          const st = await cf.status(token, c);
          console.log(`${st.url}\nsign-in: ${st.login.join(' or ')}, sessions ${st.session}\nallowed: ${[...st.emails, ...st.domains.map((d) => '@' + d)].join(', ') || 'nobody'}`);
          console.log(`machines connected: ${st.connectors.length}${st.connectors.map((x) => `\n  ${x.id.slice(0, 8)} ${x.arch} cloudflared ${x.version} since ${x.since}`).join('')}`);
          return;
        }
        if (pos[0] === 'tunnel-token') {
          const out = opt.out && opt.out !== true ? opt.out : path.join(paths.home, 'tunnel-token.for-box');
          fs.writeFileSync(out, (await cf.fetchTunnelToken(token, c)) + '\n', { mode: 0o600 });
          return console.log(`Tunnel token written to ${out} (not printed). Hand it to the box privately, then delete the file.`);
        }
        if (pos[0] === 'teardown') {
          if (!opt.yes) die('This removes the tunnel, DNS record, Access app/policy and Worker. Re-run with --yes.');
          (await cf.teardown(token, c)).forEach((l) => console.log(l));
          delete cfg.cloudflare;
          writeJSON(paths.config, cfg);
          try { fs.unlinkSync(cfg.tunnelTokenFile || path.join(paths.home, 'tunnel-token')); } catch {}
          return console.log('Cloudflare dashboard removed. Machines keep sharing usage; delete their tunnel tokens with plainsight tunnel leave.');
        }
        return die('usage: plainsight cloudflare setup|status|tunnel-token|teardown');
      }
      // access
      const st = await cf.status(token, c);
      let emails = st.emails, domains = st.domains;
      const lower = (a) => a.map((x) => x.toLowerCase());
      switch (pos[0]) {
        case 'list': case undefined:
          return console.log([...emails, ...domains.map((d) => `@${d} (whole domain)`)].join('\n') || 'nobody is allowed');
        case 'add': {
          const add = lower(pos.slice(1)); if (!add.length) die('usage: plainsight access add EMAIL [EMAIL..]');
          for (const e of add) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) die(`not an email: ${e}`);
          emails = [...new Set([...lower(emails), ...add])];
          await cf.setAccess(token, c, { emails, domains });
          return console.log(`allowed: ${emails.join(', ')}`);
        }
        case 'remove': {
          const rm = lower(pos.slice(1)); if (!rm.length) die('usage: plainsight access remove EMAIL [EMAIL..]');
          const next = lower(emails).filter((e) => !rm.includes(e));
          if (!next.length && !domains.length) die('that would leave nobody allowed; add someone first');
          await cf.setAccess(token, c, { emails: next, domains });
          for (const e of rm) { try { await cf.revoke(token, c, e); } catch {} }
          return console.log(`removed and signed out: ${rm.join(', ')}\nallowed: ${next.join(', ') || '(domains only)'}`);
        }
        case 'allow-domain': {
          const d = String(pos[1] || '').replace(/^@/, '').toLowerCase(); if (!d.includes('.')) die('usage: plainsight access allow-domain example.com');
          if (cf.PUBLIC_EMAIL_DOMAINS.includes(d) && !opt['i-understand']) die(`@${d} is a public email provider: allowing it lets anyone with such an address sign in. Add individual addresses instead (plainsight access add you@${d}), or pass --i-understand.`);
          domains = [...new Set([...domains, d])];
          await cf.setAccess(token, c, { emails, domains });
          return console.log(`every address @${d} is allowed`);
        }
        case 'remove-domain': {
          const d = String(pos[1] || '').replace(/^@/, '').toLowerCase();
          const next = domains.filter((x) => x !== d);
          if (!next.length && !emails.length) die('that would leave nobody allowed; add someone first');
          await cf.setAccess(token, c, { emails, domains: next });
          return console.log(`@${d} removed`);
        }
        case 'login': {
          const w = pos[1]; if (!['google', 'code', 'both'].includes(w)) die('usage: plainsight access login google|code|both');
          await cf.setLogin(token, c, w);
          return console.log(`sign-in options: ${w === 'both' ? 'Google or emailed code' : w === 'google' ? 'Google only' : 'emailed code only'}`);
        }
        case 'google': {
          const id = opt['client-id'], sf = opt['client-secret-file'];
          if (!id || id === true || !sf || sf === true) die(`usage: plainsight access google --client-id ID --client-secret-file FILE\nOAuth redirect URI: https://${c.authDomain}/cdn-cgi/access/callback`);
          await cf.setGoogle(token, c, id, sf);
          return console.log('Sign in with Google is on (together with emailed codes). You can delete the secret file now.');
        }
        case 'session': {
          const d = pos[1]; if (!/^\d+(m|h)$/.test(d || '')) die('usage: plainsight access session 720h   (minutes "m" or hours "h")');
          await cf.setApp(token, c, { session_duration: d });
          return console.log(`sign-ins now last ${d}`);
        }
        case 'revoke': {
          await cf.revoke(token, c, pos[1]);
          return console.log(pos[1] ? `${pos[1]} signed out everywhere` : 'everyone signed out; they must sign in again');
        }
        default: return die('usage: plainsight access list|add|remove|allow-domain|remove-domain|login|google|session|revoke');
      }
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
      return console.log(await require('../src/install').restart());
    }
    case 'install': {
      const cfg = loadConfig() || die('not initialised (plainsight init first)');
      const inst = require('../src/install');
      for (const line of inst.integrate(cfg)) console.log(`  ${line}`);
      console.log(`  ${inst.installShim()}`);
      try { console.log(`  ${inst.installService()}`); } catch (e) { console.log(`  service not installed (${e.message.split('\n')[0]}); the SessionStart hook keeps the daemon alive instead`); }
      await new Promise((r) => setTimeout(r, 1500));
      const r = await inst.ensure();
      console.log(`  daemon: ${r.started ? `started (pid ${r.pid})` : r.reason}`);
      console.log('Restart Claude Code / Codex sessions to load the MCP server and skill. Check with: plainsight doctor');
      return;
    }
    case 'uninstall': {
      const cfg = loadConfig();
      if (opt.purge && cfg && cfg.cloudflare && !opt.yes) {
        die(`--purge deletes ${paths.home}: the code, your usage history copy, the tunnel token, the Tailscale auth key file, policy backups, and the Cloudflare ids that "plainsight cloudflare teardown" needs.
If this machine set up the dashboard and you want it gone too, run "plainsight cloudflare teardown --yes" first. Then re-run with --purge --yes.`);
      }
      const inst = require('../src/install');
      console.log(`  ${await inst.stop()}`);
      inst.uninstallService();
      console.log('  background service / logon launcher removed');
      for (const l of inst.unintegrate(cfg)) console.log(`  ${l}`);
      inst.removeShim();
      console.log('  plainsight command removed');
      const tok = (cfg && cfg.tunnelTokenFile) || path.join(paths.home, 'tunnel-token');
      if (fs.existsSync(tok)) { fs.rmSync(tok, { force: true }); console.log('  tunnel token deleted (this machine no longer serves the dashboard)'); }
      if (opt.purge) {
        // the code lives inside paths.home; remove it last
        fs.rmSync(paths.home, { recursive: true, force: true });
        console.log(`  deleted ${paths.home}`);
      } else console.log(`  kept ${paths.home} (config, usage data, code). Delete it with: plainsight uninstall --purge`);
      return;
    }
    case 'mcp': return require('../src/mcp').serve();
    case 'update': {
      const root = path.resolve(__dirname, '..');
      execFileSync('git', ['-C', root, 'pull', '--ff-only'], { stdio: 'inherit' });
      // run the freshly pulled code (this process still has the old modules loaded)
      execFileSync(process.execPath, [path.join(root, 'bin', 'plainsight.js'), 'refresh'], { stdio: 'inherit' });
      return;
    }
    case 'refresh': {
      // after an update: re-copy skills, refresh hooks/MCP and the command shim, restart
      const cfg = loadConfig() || die('not initialised');
      const inst = require('../src/install');
      try { inst.integrate(cfg); } catch (e) { console.log(`integrations not refreshed: ${e.message}`); }
      try { inst.installShim(); } catch {}
      return console.log(`updated; ${await inst.restart()}`);
    }
    case 'pool': {
      const pool = require('../src/pool');
      const tf = opt['token-file'];
      if (!tf || tf === true) die('--token-file FILE is required (a Tailscale API access token; never pass the token itself on the command line)');
      const token = fs.readFileSync(tf, 'utf8').trim();
      if (pos[0] === 'bootstrap') {
        const r = await pool.bootstrap(token, { adminIp: opt['admin-ip'] !== true ? opt['admin-ip'] : undefined, apply: !!opt.apply, force: !!opt.force });
        r.out.forEach((l) => console.log(l));
        return;
      }
      if (pos[0] === 'key') {
        const file = opt.out && opt.out !== true ? opt.out : path.join(paths.home, 'tailscale-authkey.txt');
        const r = await pool.mintKey(token, file, Number(opt.days) || 90, !!opt.ephemeral);
        return console.log(`Auth key ${r.id} saved to ${r.file} (expires ${r.expires}; ${opt.ephemeral ? 'ephemeral: boxes are removed from the tailnet soon after going offline' : 'boxes stay in the tailnet while offline'}). It is not printed; hand it to new boxes privately.`);
      }
      return die('usage: plainsight pool bootstrap|key --token-file F');
    }
    case undefined: case 'help': case '--help': case '-h': return console.log(HELP);
    case '--version': case 'version': return console.log(VERSION);
    default: die(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((e) => die(e.message));
