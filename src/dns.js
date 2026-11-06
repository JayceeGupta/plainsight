'use strict';
// Optional: keep one custom DNS name (e.g. usage.example.com) pointed at whichever dashboard host
// is up. A DNS name holds one address, and an unreachable tailnet address hangs instead of
// failing fast, so listing both addresses is not an option. Instead, an owner machine that is on
// checks every minute:
//   - the tailnet Service answers (a box is hosting it)  -> point at the Service TailVIP
//     (reachable from your devices, view-only devices and boxes)
//   - it does not                                        -> point at this machine's own tailnet IP
//     (reachable from your devices; there are no boxes online to need it)
// Cloudflare only. The API token needs Zone > DNS > Edit on that one zone.
const fs = require('fs');
const http = require('http');
const { log } = require('./util');

const CF = 'https://api.cloudflare.com/client/v4';

async function cf(token, method, path, body) {
  const res = await fetch(`${CF}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) throw new Error(`Cloudflare ${method} ${path.split('?')[0]}: HTTP ${res.status} ${JSON.stringify(j.errors || '').slice(0, 200)}`);
  return j.result;
}

// Find zone + A record for a full name. Creates nothing.
async function lookup(token, name) {
  const parts = name.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const zoneName = parts.slice(i).join('.');
    const zones = await cf(token, 'GET', `/zones?name=${encodeURIComponent(zoneName)}`);
    if (zones && zones.length) {
      const recs = await cf(token, 'GET', `/zones/${zones[0].id}/dns_records?type=A&name=${encodeURIComponent(name)}`);
      if (!recs.length) throw new Error(`no A record named ${name} in zone ${zoneName}; create one first (any 100.x address)`);
      if (recs.length > 1) throw new Error(`${name} has ${recs.length} A records; keep exactly one`);
      return { zoneId: zones[0].id, recordId: recs[0].id, content: recs[0].content, proxied: recs[0].proxied };
    }
  }
  throw new Error(`no Cloudflare zone found for ${name} with this token`);
}

function probe(ip, timeout = 4000) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port: 80, path: '/api/health', timeout }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
      res.on('end', () => { try { resolve(res.statusCode === 200 && JSON.parse(b).ok === true); } catch { resolve(false); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

class DnsFollower {
  // conf: { name, zoneId, recordId, serviceIp, tokenFile }
  constructor(conf) {
    this.conf = conf;
    this.current = null;
    this.misses = 0;
  }

  async tick(selfIp) {
    const c = this.conf;
    if (!selfIp || !c.serviceIp) return;
    let token;
    try { token = fs.readFileSync(c.tokenFile, 'utf8').trim(); } catch (e) { return log(`dns: cannot read token file: ${e.message}`); }
    const up = await probe(c.serviceIp);
    // flip to the Service at once; back to this machine only after two misses in a row
    this.misses = up ? 0 : this.misses + 1;
    const want = up ? c.serviceIp : this.misses >= 2 || this.current === null ? selfIp : this.current;
    try {
      if (this.current === null) this.current = (await cf(token, 'GET', `/zones/${c.zoneId}/dns_records/${c.recordId}`)).content;
      if (want === this.current) return;
      await cf(token, 'PATCH', `/zones/${c.zoneId}/dns_records/${c.recordId}`, { content: want, ttl: 60, proxied: false });
      log(`dns: ${c.name} -> ${want} (${up ? 'tailnet Service is up' : 'no box hosting; this machine'})`);
      this.current = want;
    } catch (e) {
      log(`dns: ${e.message}`);
    }
  }
}

module.exports = { DnsFollower, lookup, probe };
