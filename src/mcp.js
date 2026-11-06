'use strict';
// MCP server over stdio (newline-delimited JSON-RPC 2.0). No network listener: the client spawns
// this process per session. Reads the merged logs from disk; works even if the daemon is down.
const readline = require('readline');
const http = require('http');
const { Store } = require('./store');
const { summarize } = require('./aggregate');
const { paths, loadConfig, VERSION } = require('./util');

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const RANGE = { type: 'string', enum: ['1h', '5h', '24h', '7d', '30d', '90d'], description: 'Time window. 5h matches the Claude/Codex rolling session window.' };
const FILTERS = {
  subscription: { type: 'string', description: 'Subscription id or label (exact or substring). Omit for all, reported separately.' },
  machine: { type: 'string', description: 'Machine nickname. Omit for all.' },
  provider: { type: 'string', enum: ['claude', 'codex'], description: 'Omit for all.' },
};

const TOOLS = [
  {
    name: 'usage',
    title: 'Usage by subscription',
    description: 'Token and API-equivalent cost totals for a time window, one entry per subscription (never summed across subscriptions), with per-machine and per-model breakdowns.',
    inputSchema: { type: 'object', properties: { range: RANGE, ...FILTERS }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'live',
    title: 'Who is using it now',
    description: 'Sessions active in the last 10 minutes (machine, subscription, model, running time, tokens), current heavy-work announcements, and which machines are online.',
    inputSchema: { type: 'object', properties: { ...FILTERS }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'machines',
    title: 'Machines',
    description: 'All machines ever seen: nickname, operator, online state, last seen, OS, subscriptions used.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'announce',
    title: 'Announce heavy work',
    description: 'Tell every machine that this machine is starting a long or heavy task (overnight run, big refactor) so others expect the shared limit to be used up. Call before starting such work.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What and why, short. No secrets or file contents.' },
        hours: { type: 'number', description: 'How long it will run (0.1 to 72).' },
        heavy: { type: 'boolean', description: 'true if it will likely use most of the 5h limit. Default true.' },
      },
      required: ['message', 'hours'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
];

function load(q) {
  const store = new Store(paths.logDir, { readonly: true });
  const tz = new Date().getTimezoneOffset();
  const data = summarize(store.all(), { ...q, tz });
  return data;
}

function resolveSub(data, s) {
  if (!s) return undefined;
  const all = data.options.subscriptions;
  const hit = all.find((x) => x.sub === s) || all.find((x) => x.label === s) || all.find((x) => x.label.toLowerCase().includes(s.toLowerCase()));
  return hit ? hit.sub : s;
}

const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const usd = (n) => `$${n.toFixed(2)}`;
const ago = (ms) => (ms < 90e3 ? `${Math.round(ms / 1e3)}s` : ms < 5400e3 ? `${Math.round(ms / 60e3)}m` : `${(ms / 3600e3).toFixed(1)}h`);

function tUsage(args) {
  const base = load({ range: '90d' });
  const q = { range: args.range || '24h', subs: resolveSub(base, args.subscription), machines: args.machine, providers: args.provider };
  const d = load(q);
  const lines = [`Usage, last ${d.range} (API-equivalent cost; each subscription separate):`];
  if (!d.subscriptions.length) lines.push('No usage in this window.');
  for (const s of d.subscriptions) {
    const t = s.totals;
    lines.push(`\n## ${s.label} [${s.provider}, ${s.sub}]`);
    lines.push(`${usd(t.cost)}${t.unpricedTokens ? ` (+${fmt(t.unpricedTokens)} unpriced tokens)` : ''} · ${fmt(t.tokens)} tokens · ${t.sessions} sessions · ${t.requests} requests`);
    lines.push(`input ${fmt(t.in)} · cache read ${fmt(t.cr)} · cache write ${fmt(t.cw)} · output ${fmt(t.out)} · cache savings ${usd(t.savings)}`);
    const mach = d.machineUsage.filter((m) => m.sub === s.sub);
    if (mach.length) lines.push('By machine: ' + mach.map((m) => `${m.machine} ${usd(m.totals.cost)} / ${fmt(m.totals.tokens)}`).join(', '));
    const models = d.models.filter((m) => m.sub === s.sub).slice(0, 6);
    if (models.length) lines.push('By model: ' + models.map((m) => `${m.model} ${m.priced ? usd(m.totals.cost) : 'unpriced'} / ${fmt(m.totals.tokens)}`).join(', '));
  }
  return { text: lines.join('\n'), data: { range: d.range, subscriptions: d.subscriptions, machineUsage: d.machineUsage, models: d.models } };
}

function tLive(args) {
  const base = load({ range: '90d' });
  const d = load({ range: '24h', subs: resolveSub(base, args.subscription), machines: args.machine, providers: args.provider });
  const now = d.now;
  const lines = [];
  lines.push(d.live.length ? `Active sessions (${d.live.length}):` : 'Nobody has used any tracked subscription in the last 10 minutes.');
  for (const s of d.live) lines.push(`- ${s.machine} · ${s.label} · ${s.model} · running ${ago(now - s.streak)} · last activity ${ago(now - s.last)} ago · ${fmt(s.totals.tokens)} tokens · ${usd(s.totals.cost)}`);
  if (d.announcements.length) {
    lines.push('\nAnnouncements:');
    for (const a of d.announcements) lines.push(`- ${a.machine}${a.op ? ` (${a.op})` : ''}: ${a.heavy ? '[HEAVY] ' : ''}${a.msg} · until ${new Date(a.until).toLocaleString()}`);
  }
  lines.push('\nMachines online: ' + (d.machines.filter((m) => m.online).map((m) => m.nick).join(', ') || 'none'));
  return { text: lines.join('\n'), data: { live: d.live, announcements: d.announcements, machines: d.machines } };
}

function tMachines() {
  const d = load({ range: '24h' });
  const now = d.now;
  const subLabel = Object.fromEntries(d.options.subscriptions.map((s) => [s.sub, s.label]));
  const lines = d.machines.map((m) => `- ${m.nick}${m.op ? ` (${m.op})` : ''}: ${m.online ? 'online' : `offline, last seen ${ago(now - m.lastSeen)} ago`} · ${m.os || '?'} · subscriptions: ${m.subs.map((s) => subLabel[s] || s).join(', ') || 'none'}`);
  return { text: lines.join('\n') || 'No machines yet.', data: { machines: d.machines } };
}

function tAnnounce(args) {
  const cfg = loadConfig();
  if (!cfg) throw new Error('plainsight is not set up on this machine');
  const body = JSON.stringify({ msg: String(args.message || '').slice(0, 200), hours: args.hours, heavy: args.heavy !== false });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: cfg.webPort, method: 'POST', path: '/api/announce', timeout: 5000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`daemon replied ${res.statusCode}: ${s}`));
        const j = JSON.parse(s);
        resolve({ text: `Announced to all machines until ${new Date(j.until).toLocaleString()}.`, data: j });
      });
    });
    req.on('timeout', () => req.destroy(new Error('daemon not responding')));
    req.on('error', (e) => reject(new Error(`plainsight daemon not running (${e.message}). Run: plainsight ensure`)));
    req.end(body);
  });
}

const HANDLERS = { usage: tUsage, live: tLive, machines: tMachines, announce: tAnnounce };

function serve() {
  const write = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const { id, method, params } = msg;
    if (id === undefined) return; // notification
    try {
      if (method === 'initialize') {
        const v = SUPPORTED.includes(params && params.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
        return write({ jsonrpc: '2.0', id, result: {
          protocolVersion: v,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'plainsight', title: 'plainsight', version: VERSION },
          instructions: 'Shared AI-usage numbers for all machines in this plainsight pool. Use `live` to see who is using a subscription right now, `usage` for totals per window, and `announce` before starting long or heavy work.',
        } });
      }
      if (method === 'ping') return write({ jsonrpc: '2.0', id, result: {} });
      if (method === 'tools/list') return write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      if (method === 'tools/call') {
        const h = HANDLERS[params && params.name];
        if (!h) return write({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params && params.name}` } });
        try {
          const r = await h((params && params.arguments) || {});
          return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], structuredContent: r.data, isError: false } });
        } catch (e) {
          return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
        }
      }
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (e) {
      write({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  });
}

module.exports = { serve, TOOLS };
