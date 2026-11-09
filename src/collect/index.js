'use strict';
// Tails tracked provider logs from saved byte offsets. First run = backfill of all history (filtered).
const fs = require('fs');
const path = require('path');
const { parseClaude, parseCodex } = require('./parsers');
const { currentSub } = require('../discover');
const { readJSON, writeJSON, paths, log } = require('../util');

const CHUNK = 8 * 1024 * 1024;

function listFiles(root, match) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
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
    if (c && Date.now() - c.at < 60e3) return c.files;
    const files = t.provider === 'claude'
      ? listFiles(path.join(t.dir, 'projects'), (n) => n.endsWith('.jsonl'))
      : listFiles(path.join(t.dir, 'sessions'), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
    this.fileLists.set(i, { at: Date.now(), files });
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

module.exports = { Collector, listFiles };
