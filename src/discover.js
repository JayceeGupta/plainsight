'use strict';
// Finds provider installs ("instances") on this machine and which account each is logged into.
// Account ids are hashed into subscription ids; emails are shown locally only, never stored or shared.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { subId } = require('./util');

function readJSONSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Claude Code keeps the account in <home>/.claude.json for the default dir,
// or <CLAUDE_CONFIG_DIR>/.claude.json when CLAUDE_CONFIG_DIR is set.
function claudeAccountFile(dir) {
  const inside = path.join(dir, '.claude.json');
  if (fs.existsSync(inside)) return inside;
  if (path.resolve(dir) === path.resolve(os.homedir(), '.claude')) return path.join(os.homedir(), '.claude.json');
  return inside;
}

function claudeAccount(dir) {
  const j = readJSONSafe(claudeAccountFile(dir));
  const a = j && j.oauthAccount;
  if (!a || !a.accountUuid) return null;
  return {
    accountId: a.accountUuid,
    email: a.emailAddress || null,
    org: a.organizationName || null,
    subscriptionCreatedAt: a.subscriptionCreatedAt || null,
  };
}

function codexAccount(dir) {
  const j = readJSONSafe(path.join(dir, 'auth.json'));
  const t = j && j.tokens;
  if (!t || !t.account_id) return null;
  let email = null, plan = null, since = null;
  try {
    const p = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString('utf8'));
    email = p.email || null;
    const au = p['https://api.openai.com/auth'] || {};
    plan = au.chatgpt_plan_type || null;
    since = au.chatgpt_subscription_active_start || null;
  } catch { /* id_token optional */ }
  return { accountId: t.account_id, email, plan, subscriptionCreatedAt: since };
}

// Cheap stats: file count and newest/oldest mtime of session logs (bounded walk).
function logStats(root, match, limit = 20000) {
  let files = 0, oldest = Infinity, newest = 0;
  const stack = [root];
  while (stack.length && files < limit) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (match(e.name)) {
        files++;
        try { const m = fs.statSync(p).mtimeMs; if (m < oldest) oldest = m; if (m > newest) newest = m; } catch {}
      }
    }
  }
  return { files, oldest: files ? new Date(oldest).toISOString() : null, newest: files ? new Date(newest).toISOString() : null };
}

function candidates(envVar, defName, marker) {
  const home = os.homedir();
  const set = new Set();
  if (process.env[envVar]) set.add(path.resolve(process.env[envVar]));
  set.add(path.join(home, defName));
  // Extra installs like ~/.claude-work, ~/.codex-personal
  try {
    for (const e of fs.readdirSync(home, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith(defName)) set.add(path.join(home, e.name));
    }
  } catch {}
  return [...set].filter((d) => isDir(path.join(d, marker)) || fs.existsSync(path.join(d, marker)));
}

function discover() {
  const out = [];
  for (const dir of candidates('CLAUDE_CONFIG_DIR', '.claude', 'projects')) {
    const acct = claudeAccount(dir);
    out.push({
      provider: 'claude',
      dir,
      account: acct && { email: acct.email, org: acct.org, subscriptionCreatedAt: acct.subscriptionCreatedAt },
      sub: acct ? subId('claude', acct.accountId) : null,
      logs: logStats(path.join(dir, 'projects'), (n) => n.endsWith('.jsonl')),
      note: 'Claude Code logs do not record which account wrote each message. History before "since" is skipped; set since to when this account started being used here.',
    });
  }
  for (const dir of candidates('CODEX_HOME', '.codex', 'sessions')) {
    const acct = codexAccount(dir);
    out.push({
      provider: 'codex',
      dir,
      account: acct && { email: acct.email, plan: acct.plan, subscriptionCreatedAt: acct.subscriptionCreatedAt },
      sub: acct ? subId('codex', acct.accountId) : null,
      logs: logStats(path.join(dir, 'sessions'), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl')),
      note: 'Codex records the account per session, so only sessions from this account are counted, even in history.',
    });
  }
  return out;
}

// Current account hash for a tracked instance (re-read on demand, cached by mtime).
const cache = new Map();
function currentSub(provider, dir) {
  const file = provider === 'claude' ? claudeAccountFile(dir) : path.join(dir, 'auth.json');
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  const c = cache.get(file);
  if (c && c.mtime === mtime) return c.sub;
  const acct = provider === 'claude' ? claudeAccount(dir) : codexAccount(dir);
  const sub = acct ? subId(provider, acct.accountId) : null;
  cache.set(file, { mtime, sub });
  return sub;
}

module.exports = { discover, currentSub, claudeAccount, codexAccount, claudeAccountFile };
