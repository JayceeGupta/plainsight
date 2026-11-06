'use strict';
// Tailnet owner bootstrap through the official Tailscale API (https://tailscale.com/api).
// Needs an API access token (Admin console > Settings > Keys > Generate access token).
const fs = require('fs');
const { TAG, SERVICE, paths } = require('./util');

const API = 'https://api.tailscale.com/api/v2';

async function api(token, method, path, { body, headers = {}, accept = 'application/json' } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return { json: text && accept === 'application/json' ? JSON.parse(text) : null, text, etag: res.headers.get('etag') };
}

const ALLOW_ALL = (g) => JSON.stringify(g.src) === '["*"]' && JSON.stringify(g.dst) === '["*"]' && JSON.stringify(g.ip || ['*']) === '["*"]';
const ALLOW_ALL_ACL = (a) => a.action === 'accept' && JSON.stringify(a.src) === '["*"]' && JSON.stringify(a.dst) === '["*:*"]';

// Build the isolated policy from the current one. Only safe automatically when the current
// policy is Tailscale's default allow-all; anything custom is left for a human to merge.
function buildPolicy(cur, adminIp) {
  const grants = cur.grants || [];
  const acls = cur.acls || [];
  const isDefault = grants.every(ALLOW_ALL) && acls.every(ALLOW_ALL_ACL) && (grants.length + acls.length) <= 1 && !cur.groups && !cur.tagOwners;
  const p = { ...cur };
  delete p.acls;
  p.tagOwners = { ...(cur.tagOwners || {}), [TAG]: ['autogroup:admin'] };
  if (adminIp) p.hosts = { ...(cur.hosts || {}), 'plainsight-admin': adminIp };
  p.grants = [
    ...grants.filter((g) => !ALLOW_ALL(g) && !JSON.stringify(g).includes('plainsight')),
    { src: ['autogroup:member'], dst: ['autogroup:member', 'autogroup:internet'], ip: ['*'] },
    { src: ['autogroup:member'], dst: [SERVICE], ip: ['tcp:80', 'tcp:443'] },
    { src: [TAG], dst: [TAG], ip: ['tcp:4747'] },
    ...(adminIp ? [{ src: ['plainsight-admin'], dst: [TAG], ip: ['*'] }] : []),
  ];
  p.autoApprovers = { ...(cur.autoApprovers || {}), services: { ...((cur.autoApprovers || {}).services || {}), [SERVICE]: [TAG] } };
  p.tests = [
    ...(cur.tests || []).filter((t) => !JSON.stringify(t).includes('plainsight')),
    { src: TAG, accept: [`${TAG}:4747`], deny: [`${TAG}:22`, ...(adminIp ? [`${adminIp}:445`] : [])] },
    ...(adminIp ? [{ src: adminIp, accept: [`${TAG}:4747`, `${TAG}:22`] }] : []),
  ];
  return { policy: p, isDefault };
}

async function bootstrap(token, { adminIp, apply, force }) {
  const out = [];
  const { json: cur, etag } = await api(token, 'GET', '/tailnet/-/acl');
  const backup = `${paths.home}/policy-backup-${Date.now()}.json`;
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(backup, JSON.stringify(cur, null, 2));
  out.push(`Backed up current policy to ${backup}`);
  const { policy, isDefault } = buildPolicy(cur, adminIp);
  const proposed = `${paths.home}/policy-proposed.json`;
  fs.writeFileSync(proposed, JSON.stringify(policy, null, 2));
  await api(token, 'POST', '/tailnet/-/acl/validate', { body: policy });
  out.push(`Proposed policy validated by Tailscale: ${proposed}`);
  if (!isDefault && !force) {
    out.push('Your policy has custom rules, so it was NOT applied. Review the proposed file (it keeps your other rules, but replaces any allow-all grant) and re-run with --force, or merge by hand. See docs/TAILNET.md.');
    return { out, applied: false };
  }
  if (!apply) { out.push('Dry run. Re-run with --apply to save it.'); return { out, applied: false }; }
  await api(token, 'POST', '/tailnet/-/acl', { body: policy, headers: etag ? { 'if-match': etag } : {} });
  out.push('Policy applied.');
  const svc = await api(token, 'PUT', `/tailnet/-/vip-services/${SERVICE}`, { body: { name: SERVICE, comment: 'plainsight dashboard (any tagged box can host)', ports: ['tcp:80', 'tcp:443'], tags: [TAG] } });
  out.push(`Service ${SERVICE} defined. TailVIP: ${(svc.json.addrs || []).join(', ')}`);
  return { out, applied: true, addrs: svc.json.addrs || [] };
}

async function mintKey(token, file, days = 90) {
  const { json } = await api(token, 'POST', '/tailnet/-/keys', {
    body: { description: 'plainsight boxes', expirySeconds: days * 86400, capabilities: { devices: { create: { reusable: true, ephemeral: true, preauthorized: true, tags: [TAG] } } } },
  });
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, json.key + '\n', { mode: 0o600 });
  return { id: json.id, expires: json.expires, file };
}

module.exports = { bootstrap, mintKey, buildPolicy };
