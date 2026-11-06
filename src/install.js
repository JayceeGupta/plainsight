'use strict';
// Host integration: background service, Claude Code hook, MCP registration, skills.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync, execSync } = require('child_process');
const { paths, readJSON, writeJSON, loadConfig } = require('./util');

const BIN = path.resolve(__dirname, '..', 'bin', 'plainsight.js');
const NODE = process.execPath;
const q = (s) => `"${s}"`;
const startupVbs = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'plainsight.vbs');

function health(port, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(s) : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const UNIT = () => path.join(os.homedir(), '.config', 'systemd', 'user', 'plainsight.service');
const PLIST = () => path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.plainsight.daemon.plist');
const LABEL = 'com.plainsight.daemon';
const sh = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 20000 }); return true; } catch { return false; } };

// Which supervisor owns the daemon on this machine, if any. When one does, plainsight must go
// through it: starting a second copy by hand fights the supervisor (it restarts its own copy).
function supervisor() {
  if (process.platform === 'linux' && fs.existsSync(UNIT()) && sh('systemctl', ['--user', 'is-enabled', 'plainsight'])) return 'systemd';
  if (process.platform === 'darwin' && fs.existsSync(PLIST())) return 'launchd';
  return null;
}

function postStop(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/stop', timeout: 3000, headers: { 'content-length': 0 } }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('timeout', () => req.destroy());
    req.on('error', resolve);
    req.end();
  });
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 300)); }
  return false;
}

// Start the daemon if it is not answering. Never throws (used from hooks).
async function ensure() {
  const cfg = loadConfig();
  if (!cfg) return { started: false, reason: 'not initialised' };
  if (await health(cfg.webPort)) return { started: false, reason: 'already running' };
  const sup = supervisor();
  if (sup === 'systemd' && sh('systemctl', ['--user', 'start', 'plainsight'])) return { started: true, via: 'systemd' };
  if (sup === 'launchd') {
    const uid = process.getuid();
    if (sh('launchctl', ['kickstart', `gui/${uid}/${LABEL}`]) || sh('launchctl', ['bootstrap', `gui/${uid}`, PLIST()])) return { started: true, via: 'launchd' };
  }
  fs.mkdirSync(paths.home, { recursive: true });
  const out = fs.openSync(paths.daemonLog, 'a');
  const child = spawn(NODE, [BIN, 'daemon'], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  return { started: true, pid: child.pid };
}

// Stop until the next ensure()/login. With a supervisor, stop it there so it does not respawn.
async function stop() {
  const cfg = loadConfig();
  if (!cfg) return 'not initialised';
  const sup = supervisor();
  if (sup === 'systemd') { sh('systemctl', ['--user', 'stop', 'plainsight']); }
  else if (sup === 'launchd') { sh('launchctl', ['bootout', `gui/${process.getuid()}`, PLIST()]); }
  if (await health(cfg.webPort)) await postStop(cfg.webPort);
  const down = await waitFor(async () => !(await health(cfg.webPort, 800)), 8000);
  return down ? `stopped${sup ? ` (${sup})` : ''}` : 'asked the daemon to stop, but it still answers';
}

// Restart so new code or config takes effect.
async function restart() {
  const cfg = loadConfig();
  if (!cfg) return 'not initialised';
  const sup = supervisor();
  if (sup === 'systemd') { sh('systemctl', ['--user', 'restart', 'plainsight']); }
  else if (sup === 'launchd') { sh('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`]) || sh('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST()]); }
  else {
    if (await health(cfg.webPort)) await postStop(cfg.webPort);
    await waitFor(async () => !(await health(cfg.webPort, 800)), 8000);
    await ensure();
  }
  const up = await waitFor(() => health(cfg.webPort, 800), 15000);
  return up ? `restarted${sup ? ` (${sup})` : ''}` : `restart requested; the daemon is not answering yet (see ${paths.daemonLog})`;
}

function installService() {
  const p = process.platform;
  if (p === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plainsight.service'), [
      '[Unit]', 'Description=plainsight usage sharing daemon', 'After=network-online.target', '',
      '[Service]', `ExecStart=${q(NODE)} ${q(BIN)} daemon`, 'Restart=always', 'RestartSec=10', '',
      '[Install]', 'WantedBy=default.target', '',
    ].join('\n'));
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
      execFileSync('systemctl', ['--user', 'enable', '--now', 'plainsight'], { stdio: 'inherit' });
    } catch {
      return 'systemd --user is not available here. The Claude Code SessionStart hook will start the daemon instead (run `plainsight ensure` manually otherwise).';
    }
    let linger = '';
    try { execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'ignore' }); }
    catch { linger = ' WARNING: could not enable lingering, so the daemon stops when you log out. Run: sudo loginctl enable-linger $USER'; }
    return `Installed systemd user service \`plainsight\` (systemctl --user status plainsight).${linger}`;
  }
  if (p === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.plainsight.daemon.plist');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.plainsight.daemon</string>
  <key>ProgramArguments</key><array><string>${NODE}</string><string>${BIN}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${paths.daemonLog}</string>
  <key>StandardErrorPath</key><string>${paths.daemonLog}</string>
</dict></plist>
`);
    const uid = process.getuid();
    try { execFileSync('launchctl', ['bootout', `gui/${uid}`, plist], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { stdio: 'inherit' });
    return `Installed LaunchAgent ${plist}.`;
  }
  if (p === 'win32') {
    const vbs = path.join(paths.home, 'plainsight-daemon.vbs');
    // Runs node with no console window; output goes to daemon.log.
    const cmd = `cmd /c "${q(NODE)} ${q(BIN)} daemon >> ${q(paths.daemonLog)} 2>&1"`;
    fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`);
    // Per-user Startup folder: runs at logon without admin rights (schtasks ONLOGON needs admin).
    fs.copyFileSync(vbs, startupVbs());
    return `Installed logon launcher ${startupVbs()} (hidden window).`;
  }
  return `Unsupported platform ${p}; rely on the SessionStart hook or run \`plainsight daemon\` yourself.`;
}

function uninstallService() {
  const p = process.platform;
  try {
    if (p === 'linux') {
      execFileSync('systemctl', ['--user', 'disable', '--now', 'plainsight'], { stdio: 'ignore' });
      fs.rmSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'plainsight.service'), { force: true });
    } else if (p === 'darwin') {
      const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.plainsight.daemon.plist');
      try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, plist], { stdio: 'ignore' }); } catch {}
      fs.rmSync(plist, { force: true });
    } else if (p === 'win32') {
      fs.rmSync(startupVbs(), { force: true });
    }
  } catch { /* already gone */ }
}

const HOOK_CMD = `${q(NODE)} ${q(BIN)} ensure --quiet`;

const isOurs = (cmd) => /plainsight(\.js)?"?\s+ensure/.test(String(cmd || ''));

// Claude Code: SessionStart hook (keeps the daemon alive), MCP server, skill. Per tracked instance.
function integrateClaude(dir) {
  const done = [];
  const settingsFile = path.join(dir, 'settings.json');
  const s = readJSON(settingsFile, {});
  if (fs.existsSync(settingsFile)) fs.copyFileSync(settingsFile, `${settingsFile}.bak-plainsight`);
  s.hooks = s.hooks || {};
  // replace any earlier plainsight hook (older versions were not --quiet)
  s.hooks.SessionStart = (s.hooks.SessionStart || [])
    .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h.command)) }))
    .filter((m) => m.hooks.length);
  s.hooks.SessionStart.push({ hooks: [{ type: 'command', command: HOOK_CMD, timeout: 10 }] });
  // Keep transcripts long enough for history (default cleanup is 30 days).
  if (!s.cleanupPeriodDays || s.cleanupPeriodDays < 365) s.cleanupPeriodDays = 3650;
  writeJSON(settingsFile, s);
  done.push(`hook + cleanupPeriodDays in ${settingsFile}`);

  // MCP: use the claude CLI (it owns ~/.claude.json, which Claude Code rewrites constantly).
  const run = claudeRunner(dir);
  try { run(['mcp', 'remove', '--scope', 'user', 'plainsight']); } catch {}
  try {
    run(['mcp', 'add', '--scope', 'user', 'plainsight', '--', NODE, BIN, 'mcp']);
    done.push('MCP server registered (claude mcp add --scope user plainsight)');
  } catch {
    done.push(`MCP NOT registered, run: claude mcp add --scope user plainsight -- "${NODE}" "${BIN}" mcp`);
  }
  done.push(copySkill(path.join(dir, 'skills')));
  return done;
}

// Codex: MCP server in config.toml, skill.
function integrateCodex(dir) {
  const done = [];
  const toml = path.join(dir, 'config.toml');
  const cur = fs.existsSync(toml) ? fs.readFileSync(toml, 'utf8') : '';
  if (!/^\[mcp_servers\.plainsight\]/m.test(cur)) {
    if (cur) fs.copyFileSync(toml, `${toml}.bak-plainsight`);
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    fs.appendFileSync(toml, `${cur && !cur.endsWith('\n') ? '\n' : ''}\n[mcp_servers.plainsight]\ncommand = "${esc(NODE)}"\nargs = ["${esc(BIN)}", "mcp"]\n`);
  }
  done.push(`MCP server in ${toml}`);
  done.push(copySkill(path.join(dir, 'skills')));
  return done;
}

// Windows: `claude` may be a .cmd shim, which needs a shell; pass one pre-quoted command string.
function claudeRunner(dir) {
  const env = { ...process.env };
  if (path.resolve(dir) !== path.resolve(os.homedir(), '.claude')) env.CLAUDE_CONFIG_DIR = dir;
  const opts = { env, stdio: 'ignore', timeout: 60000 };
  return (args) => (process.platform === 'win32'
    ? execSync(['claude', ...args.map((a) => (/[\s"]/.test(a) ? q(a) : a))].join(' '), opts)
    : execFileSync('claude', args, opts));
}

function copySkill(skillsDir) {
  const src = path.resolve(__dirname, '..', 'skills', 'plainsight');
  const dst = path.join(skillsDir, 'plainsight');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(src, 'SKILL.md'), path.join(dst, 'SKILL.md'));
  return `skill in ${dst}`;
}

function integrate(cfg) {
  const out = [];
  const seen = new Set();
  for (const t of cfg.tracked) {
    const key = `${t.provider}|${t.dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(...(t.provider === 'claude' ? integrateClaude(t.dir) : integrateCodex(t.dir)));
  }
  return out;
}

// Undo integrate(): hook, MCP registration, skills. cleanupPeriodDays is left as is (it only keeps
// your own transcripts longer); settings.json.bak-plainsight holds the pre-install copy.
function unintegrate(cfg) {
  const out = [];
  const seen = new Set();
  for (const t of (cfg && cfg.tracked) || []) {
    const key = `${t.provider}|${t.dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (t.provider === 'claude') {
      const f = path.join(t.dir, 'settings.json');
      const s = readJSON(f, null);
      if (s && s.hooks && s.hooks.SessionStart) {
        s.hooks.SessionStart = s.hooks.SessionStart.map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h.command)) })).filter((m) => m.hooks.length);
        if (!s.hooks.SessionStart.length) delete s.hooks.SessionStart;
        writeJSON(f, s);
        out.push(`hook removed from ${f}`);
      }
      try { claudeRunner(t.dir)(['mcp', 'remove', '--scope', 'user', 'plainsight']); out.push(`MCP server removed (${t.dir})`); } catch { out.push(`MCP: run claude mcp remove --scope user plainsight (${t.dir})`); }
    } else {
      const toml = path.join(t.dir, 'config.toml');
      if (fs.existsSync(toml)) {
        const cur = fs.readFileSync(toml, 'utf8');
        const next = cur.replace(/\n?\[mcp_servers\.plainsight\][^[]*/m, '\n');
        if (next !== cur) { fs.writeFileSync(toml, next.replace(/\n{3,}/g, '\n\n')); out.push(`MCP block removed from ${toml}`); }
      }
    }
    fs.rmSync(path.join(t.dir, 'skills', 'plainsight'), { recursive: true, force: true });
    out.push(`skill removed from ${path.join(t.dir, 'skills')}`);
  }
  return out;
}

// A `plainsight` command on PATH, so nobody has to type node + the full path.
const SHIM_DIR = () => (process.platform === 'win32' ? path.join(paths.home, 'bin') : path.join(os.homedir(), '.local', 'bin'));
function installShim() {
  const dir = SHIM_DIR();
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'plainsight.cmd'), `@echo off\r\n"${NODE}" "${BIN}" %*\r\n`);
    // add to the user PATH through .NET so open Explorer/new terminals see it (no admin needed)
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$d=$env:PS_DIR; $p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''}; if(($p -split ';') -notcontains $d){[Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $d).TrimStart(';'), 'User')}"],
      { env: { ...process.env, PS_DIR: dir }, stdio: 'ignore', timeout: 30000 });
      return `command \`plainsight\` installed (${dir}; open a new terminal to use it)`;
    } catch { return `command shim at ${dir}\\plainsight.cmd; add ${dir} to your PATH to type just \`plainsight\``; }
  }
  const link = path.join(dir, 'plainsight');
  try { fs.chmodSync(BIN, 0o755); } catch {}
  try { fs.rmSync(link, { force: true }); fs.symlinkSync(BIN, link); } catch (e) { return `could not create ${link}: ${e.message}`; }
  const onPath = String(process.env.PATH || '').split(':').includes(dir);
  return `command \`plainsight\` installed (${link})${onPath ? '' : `; ${dir} is not on your PATH yet: add  export PATH="$HOME/.local/bin:$PATH"  to your shell profile`}`;
}

function removeShim() {
  const dir = SHIM_DIR();
  if (process.platform === 'win32') {
    fs.rmSync(path.join(dir, 'plainsight.cmd'), { force: true });
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$d=$env:PS_DIR; $p=[Environment]::GetEnvironmentVariable('Path','User'); if($p){[Environment]::SetEnvironmentVariable('Path', (($p -split ';') | Where-Object { $_ -and $_ -ne $d }) -join ';', 'User')}"],
      { env: { ...process.env, PS_DIR: dir }, stdio: 'ignore', timeout: 30000 });
    } catch {}
  } else {
    const link = path.join(dir, 'plainsight');
    try { if (fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === BIN) fs.rmSync(link); } catch {}
  }
}

module.exports = { ensure, stop, restart, supervisor, health, installService, uninstallService, integrate, unintegrate, installShim, removeShim, BIN, NODE };
