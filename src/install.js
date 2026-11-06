'use strict';
// Host integration: background service, Claude Code hook, MCP registration, skills.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { paths, readJSON, writeJSON, loadConfig } = require('./util');

const BIN = path.resolve(__dirname, '..', 'bin', 'plainsight.js');
const NODE = process.execPath;
const q = (s) => `"${s}"`;

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

// Start the daemon in the background if it is not answering. Never throws (used from hooks).
async function ensure() {
  const cfg = loadConfig();
  if (!cfg) return { started: false, reason: 'not initialised' };
  if (await health(cfg.webPort)) return { started: false, reason: 'already running' };
  fs.mkdirSync(paths.home, { recursive: true });
  const out = fs.openSync(paths.daemonLog, 'a');
  const child = spawn(NODE, [BIN, 'daemon'], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  return { started: true, pid: child.pid };
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
    try { execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'ignore' }); } catch {}
    return 'Installed systemd user service `plainsight` (systemctl --user status plainsight).';
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
    execFileSync('schtasks', ['/Create', '/TN', 'plainsight', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F', '/TR', `wscript.exe "${vbs}"`], { stdio: 'inherit' });
    execFileSync('schtasks', ['/Run', '/TN', 'plainsight'], { stdio: 'inherit' });
    return 'Installed scheduled task `plainsight` (runs at logon, hidden).';
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
      execFileSync('schtasks', ['/Delete', '/TN', 'plainsight', '/F'], { stdio: 'ignore' });
    }
  } catch { /* already gone */ }
}

const HOOK_CMD = `${q(NODE)} ${q(BIN)} ensure`;

// Claude Code: SessionStart hook (keeps the daemon alive), MCP server, skill. Per tracked instance.
function integrateClaude(dir) {
  const done = [];
  const settingsFile = path.join(dir, 'settings.json');
  const s = readJSON(settingsFile, {});
  if (fs.existsSync(settingsFile)) fs.copyFileSync(settingsFile, `${settingsFile}.bak-plainsight`);
  s.hooks = s.hooks || {};
  const ss = (s.hooks.SessionStart = s.hooks.SessionStart || []);
  const has = ss.some((m) => (m.hooks || []).some((h) => String(h.command || '').includes('plainsight')));
  if (!has) ss.push({ hooks: [{ type: 'command', command: HOOK_CMD, timeout: 10 }] });
  // Keep transcripts long enough for history (default cleanup is 30 days).
  if (!s.cleanupPeriodDays || s.cleanupPeriodDays < 365) s.cleanupPeriodDays = 3650;
  writeJSON(settingsFile, s);
  done.push(`hook + cleanupPeriodDays in ${settingsFile}`);

  // MCP: use the claude CLI (it owns ~/.claude.json, which Claude Code rewrites constantly).
  const env = { ...process.env };
  if (path.resolve(dir) !== path.resolve(os.homedir(), '.claude')) env.CLAUDE_CONFIG_DIR = dir;
  const win = process.platform === 'win32';
  const opts = { env, stdio: 'ignore', shell: win };
  const arg = (s) => (win ? q(s) : s);
  try { execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'plainsight'], opts); } catch {}
  try {
    execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'plainsight', '--', arg(NODE), arg(BIN), 'mcp'], opts);
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

module.exports = { ensure, health, installService, uninstallService, integrate, BIN, NODE };
