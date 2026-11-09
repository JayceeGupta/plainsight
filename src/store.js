'use strict';
// Append-only, single-writer-per-origin event logs. Merge = union. One file per origin: log/<origin>.jsonl
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const KINDS = new Set(['hello', 'sub', 'u', 'hb', 'ann', 'bye', 'color']);
const NUM_FIELDS = ['in', 'cr', 'cw', 'out', 'rs', 'until', 'hours'];
const STR_FIELDS = ['o', 'k', 'sub', 'p', 'sid', 'm', 'id', 'nick', 'host', 'os', 'op', 'ver', 'label', 'msg', 'mach', 'c'];
const MAX_LINE = 2048;
const ORIGIN_RE = /^[a-f0-9]{8,32}$/;

function validateEvent(ev, origin, seq) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return 'not an object';
  if (ev.o !== origin) return 'origin mismatch';
  if (ev.s !== seq) return `seq ${ev.s} != ${seq}`;
  if (!KINDS.has(ev.k)) return `unknown kind ${ev.k}`;
  if (typeof ev.t !== 'number' || !Number.isFinite(ev.t) || ev.t < 1.5e12 || ev.t > Date.now() + 864e5) return 'bad time';
  for (const f of NUM_FIELDS) {
    if (f in ev && (typeof ev[f] !== 'number' || !Number.isFinite(ev[f]) || ev[f] < 0 || ev[f] > 1e13)) return `bad ${f}`;
  }
  for (const f of STR_FIELDS) {
    if (f in ev && (typeof ev[f] !== 'string' || ev[f].length > 300)) return `bad ${f}`;
  }
  if ('heavy' in ev && typeof ev.heavy !== 'boolean') return 'bad heavy';
  if ('bf' in ev && ev.bf !== 1) return 'bad bf';
  if (ev.k === 'color' && !/^#[0-9a-f]{6}$/.test(ev.c || '')) return 'bad color';
  if ('lim' in ev && !(Array.isArray(ev.lim) && ev.lim.length <= 4 && ev.lim.every((w) => w && typeof w === 'object'
    && [w.m, w.u, w.r].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e13)))) return 'bad lim';
  return null;
}

class Store extends EventEmitter {
  constructor(dir, { readonly = false } = {}) {
    super();
    this.setMaxListeners(100);
    this.dir = dir;
    this.readonly = readonly;
    this.logs = new Map(); // origin -> events[]
    if (!readonly) fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')); } catch { return; }
    for (const f of files) {
      const origin = f.slice(0, -6);
      if (!ORIGIN_RE.test(origin)) continue;
      const file = path.join(this.dir, f);
      const buf = fs.readFileSync(file);
      const events = [];
      let pos = 0;
      let validBytes = 0;
      while (pos < buf.length) {
        const nl = buf.indexOf(10, pos);
        if (nl === -1) break; // partial last line (crash mid-write): drop
        const line = buf.toString('utf8', pos, nl);
        let ev;
        try { ev = JSON.parse(line); } catch { break; }
        if (validateEvent(ev, origin, events.length + 1)) break;
        events.push(ev);
        pos = nl + 1;
        validBytes = pos;
      }
      if (validBytes < buf.length && !this.readonly) fs.truncateSync(file, validBytes);
      this.logs.set(origin, events);
    }
  }

  get(origin) {
    let l = this.logs.get(origin);
    if (!l) { l = []; this.logs.set(origin, l); }
    return l;
  }

  vv() {
    const v = {};
    for (const [o, l] of this.logs) if (l.length) v[o] = l.length;
    return v;
  }

  *all() {
    for (const l of this.logs.values()) yield* l;
  }

  // Local writer: assigns seq numbers. Only the daemon process calls this.
  appendLocal(origin, evs) {
    if (this.readonly) throw new Error('store is read-only');
    if (!evs.length) return [];
    const l = this.get(origin);
    const out = [];
    let text = '';
    for (const e of evs) {
      const ev = { o: origin, s: l.length + out.length + 1, t: e.t || Date.now(), ...e };
      ev.o = origin; ev.s = l.length + out.length + 1;
      const err = validateEvent(ev, origin, ev.s);
      if (err) throw new Error(`invalid local event: ${err}`);
      const line = JSON.stringify(ev);
      if (line.length > MAX_LINE) throw new Error('event too large');
      out.push(ev);
      text += line + '\n';
    }
    fs.appendFileSync(path.join(this.dir, `${origin}.jsonl`), text);
    l.push(...out);
    this.emit('change', { origin, local: true, count: out.length });
    return out;
  }

  // Remote events for `origin` starting at seq `from`. Accepts the valid contiguous prefix.
  ingest(origin, from, lines, selfOrigin) {
    if (this.readonly) throw new Error('store is read-only');
    if (!ORIGIN_RE.test(origin) || origin === selfOrigin) return 0;
    if (!Number.isInteger(from) || from < 1 || !Array.isArray(lines)) return 0;
    const l = this.get(origin);
    let skip = l.length + 1 - from; // overlap we already have
    if (skip < 0) return 0; // gap: caller must resend from our count
    const out = [];
    let text = '';
    for (const raw of lines.slice(skip)) {
      if (typeof raw !== 'string' || raw.length > MAX_LINE) break;
      let ev;
      try { ev = JSON.parse(raw); } catch { break; }
      if (validateEvent(ev, origin, l.length + out.length + 1)) break;
      out.push(ev);
      text += raw + '\n';
    }
    if (!out.length) return 0;
    fs.appendFileSync(path.join(this.dir, `${origin}.jsonl`), text);
    l.push(...out);
    this.emit('change', { origin, local: false, count: out.length });
    return out.length;
  }

  // Raw lines for origin after `have` events, at most `max`.
  linesAfter(origin, have, max) {
    const l = this.logs.get(origin) || [];
    return l.slice(have, have + max).map((e) => JSON.stringify(e));
  }
}

module.exports = { Store, validateEvent, KINDS };
