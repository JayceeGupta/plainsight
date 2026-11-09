'use strict';
// Tails tracked provider logs from saved byte offsets. First run = backfill of all history (filtered).
const fs = require('fs');
const path = require('path');
const { parseClaude, parseCodex } = require('./parsers');
const { currentSub } = require('../discover');
const { readJSON, writeJSON, paths, log, hash } = require('../util');

const CHUNK = 8 * 1024 * 1024;

function listFiles(root, match, dirs) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    if (dirs) dirs.push(d);
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (match(e.name)) out.push(p);
    }
  }
  return out;
}

class Collector {
  constructor(cfg, store) {
    this.cfg = cfg;
    this.store = store;
    this.state = readJSON(paths.state, { files: {}, installedAt: Date.now() });
    if (!this.state.installedAt) this.state.installedAt = Date.now();
    this.fileLists = new Map(); // tracked index -> { at, files }
    this.seen = new Set();
    for (const ev of store.get(cfg.nodeId)) if (ev.id) this.seen.add(ev.id);
    this.warned = new Set();
    this.busy = false;
  }

  files(i, t) {
    const c = this.fileLists.get(i);
    // a new file changes its folder's mtime: relist only then (or once a minute), so a new session is seen on the next scan
    const mt = (d) => { try { return fs.statSync(d).mtimeMs; } catch { return -1; } };
    if (c && Date.now() - c.at < 60e3 && c.dirs.every(([d, m]) => mt(d) === m)) return c.files;
    const dirs = [];
    const files = t.provider === 'claude'
      ? listFiles(path.join(t.dir, 'projects'), (n) => n.endsWith('.jsonl'), dirs)
      : listFiles(path.join(t.dir, 'sessions'), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), dirs);
    this.fileLists.set(i, { at: Date.now(), files, dirs: dirs.map((d) => [d, mt(d)]) });
    return files;
  }

  // Returns number of new events appended.
  async scan() {
    if (this.busy) return 0;
    this.busy = true;
    let added = 0;
    try {
      for (let i = 0; i < this.cfg.tracked.length; i++) added += await this.scanTracked(i, this.cfg.tracked[i]);
      writeJSON(paths.state, this.state);
    } finally { this.busy = false; }
    return added;
  }

  async scanTracked(i, t) {
    const since = t.since ? Date.parse(t.since) : 0;
    const liveSub = currentSub(t.provider, t.dir);
    let added = 0;
    let n = 0;
    for (const file of this.files(i, t)) {
      if (++n % 25 === 0) await new Promise((r) => setImmediate(r)); // keep the server responsive during backfill
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const key = `${t.provider}|${file}`;
      const fsState = this.state.files[key] || (this.state.files[key] = { off: 0, ctx: {} });
      if (st.size < fsState.off) { fsState.off = 0; fsState.ctx = {}; } // rewritten
      if (st.size === fsState.off) continue;
      const fd = fs.openSync(file, 'r');
      try {
        while (fsState.off < st.size) {
          const len = Math.min(CHUNK, st.size - fsState.off);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, fsState.off);
          const lastNl = buf.lastIndexOf(10);
          if (lastNl === -1) {
            if (len === CHUNK) { fsState.off += len; continue; } // absurd single line: skip
            break; // partial line still being written
          }
          const lines = buf.toString('utf8', 0, lastNl).split('\n');
          fsState.off += lastNl + 1;
          const raw = t.provider === 'claude' ? parseClaude(lines, fsState.ctx) : parseCodex(lines, fsState.ctx);
          const evs = [];
          for (const ev of raw) {
            if (this.seen.has(ev.id)) continue;
            if (!this.belongs(t, ev, since, liveSub)) continue;
            this.seen.add(ev.id);
            delete ev.acctSub;
            ev.sub = t.sub;
            if (ev.t < this.state.installedAt) ev.bf = 1;
            evs.push(ev);
          }
          if (evs.length) { this.store.appendLocal(this.cfg.nodeId, evs); added += evs.length; }
        }
      } finally { fs.closeSync(fd); }
    }
    return added;
  }

  // sid = the hashed session id used in events. Claude files are named <sessionId>.jsonl; Codex
  // rollout files end in the session uuid.
  sessionInfo(sid) {
    for (let i = 0; i < this.cfg.tracked.length; i++) {
      const t = this.cfg.tracked[i];
      for (const file of this.files(i, t)) {
        const base = path.basename(file, '.jsonl');
        const id = t.provider === 'claude' ? base : (base.match(/[0-9a-f]{8}-[0-9a-f-]{27}$/) || [])[0];
        if (id && hash(id, 12) === sid) return readSession(file, t.provider, id);
      }
    }
    return null;
  }

  // Strict account guard: never attribute usage to the wrong subscription.
  belongs(t, ev, since, liveSub) {
    if (ev.t < since) return false;
    if (t.provider === 'codex') {
      // Codex: exact per-session account. Sessions without account info fall back to the live login.
      return (ev.acctSub || liveSub) === t.sub;
    }
    // Claude: no per-line account. After install, require the instance to be logged into the
    // tracked account right now (lines are read within seconds of being written).
    if (ev.t >= this.state.installedAt && liveSub !== t.sub) {
      const w = `${t.dir}|${liveSub}`;
      if (!this.warned.has(w)) { this.warned.add(w); log(`skip: ${t.dir} is logged into a different account than tracked subscription ${t.label}`); }
      return false;
    }
    return true;
  }
}

// The head and tail of a transcript are enough: the start, and the newest title, effort and place.
function readSession(file, provider, id) {
  const size = fs.statSync(file).size, HEAD = 256 * 1024, TAIL = 2 * 1024 * 1024;
  const fd = fs.openSync(file, 'r');
  const part = (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b.toString('utf8'); };
  let text;
  try { text = size <= HEAD + TAIL ? part(0, size) : part(0, HEAD) + '\n' + part(size - TAIL, TAIL); } finally { fs.closeSync(fd); }
  const info = { id, provider };
  const str = (v, n = 200) => (typeof v === 'string' && v ? v.slice(0, n) : undefined);
  for (const line of text.split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(o.timestamp);
    if (Number.isFinite(ts) && !info.start) info.start = ts;
    if (provider === 'claude') {
      if (o.type === 'custom-title') info.title = str(o.customTitle);
      else if (o.type === 'ai-title' && !info.custom) info.aiTitle = str(o.aiTitle);
      if (o.type === 'custom-title') info.custom = true;
      if (str(o.effort)) info.effort = o.effort;
      if (o.type === 'user' || o.type === 'assistant') {
        info.cwd = str(o.cwd, 400) || info.cwd; info.branch = str(o.gitBranch, 100) || info.branch;
        info.via = str(o.entrypoint, 40) || info.via; info.ver = str(o.version, 40) || info.ver;
      }
    } else {
      const p = o.payload || {};
      if (o.type === 'session_meta') { info.cwd = str(p.cwd, 400); info.via = str(p.originator, 40); info.ver = str(p.cli_version, 40); }
      if (o.type === 'turn_context') { info.effort = str(p.effort) || str(p.reasoning_effort) || info.effort; info.cwd = str(p.cwd, 400) || info.cwd; }
    }
  }
  info.title = info.title || info.aiTitle;
  delete info.aiTitle; delete info.custom;
  info.project = info.cwd ? path.basename(info.cwd) : undefined;
  return info;
}

module.exports = { Collector, listFiles, readSession };
