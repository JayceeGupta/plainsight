'use strict';
// Tailnet owner bootstrap through the official Tailscale API (https://tailscale.com/api).
// Needs an API access token (Admin console > Settings > Keys > Generate access token).
const fs = require('fs');
const { TAG, VIEWER_TAG, SERVICE, WEB_PORT, paths } = require('./util');

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
  p.tagOwners = { ...(cur.tagOwners || {}), [TAG]: ['autogroup:admin'], [VIEWER_TAG]: ['autogroup:admin'] };
  if (adminIp) p.hosts = { ...(cur.hosts || {}), 'plainsight-admin': adminIp };
  p.grants = [
    ...grants.filter((g) => !ALLOW_ALL(g) && !JSON.stringify(g).includes('plainsight')),
    { src: ['autogroup:member'], dst: ['autogroup:member', 'autogroup:internet'], ip: ['*'] },
    { src: ['autogroup:member'], dst: [SERVICE], ip: ['tcp:80', 'tcp:443'] },
    { src: [TAG], dst: [TAG], ip: ['tcp:4747'] },
    ...(adminIp ? [{ src: ['plainsight-admin'], dst: [TAG], ip: ['*'] }] : []),
    // view-only devices (e.g. phones): the dashboard and nothing else; nothing may connect to them
    { src: [VIEWER_TAG], dst: [SERVICE], ip: ['tcp:80', 'tcp:443'] },
    ...(adminIp ? [{ src: [VIEWER_TAG], dst: ['plainsight-admin'], ip: [`tcp:${WEB_PORT}`] }] : []),
  ];
  p.autoApprovers = { ...(cur.autoApprovers || {}), services: { ...((cur.autoApprovers || {}).services || {}), [SERVICE]: [TAG] } };
  p.tests = [
    ...(cur.tests || []).filter((t) => !JSON.stringify(t).includes('plainsight')),
    { src: TAG, accept: [`${TAG}:4747`], deny: [`${TAG}:22`, ...(adminIp ? [`${adminIp}:445`] : [])] },
    ...(adminIp ? [{ src: adminIp, accept: [`${TAG}:4747`, `${TAG}:22`] }] : []),
    { src: VIEWER_TAG, deny: [`${TAG}:4747`, `${TAG}:22`, ...(adminIp ? [`${adminIp}:22`, `${adminIp}:445`, `${adminIp}:443`] : [])], ...(adminIp ? { accept: [`${adminIp}:${WEB_PORT}`] } : {}) },
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

// Box key: reusable + ephemeral. Viewer key: one device, single use, not ephemeral (a phone stays).
async function mintKey(token, file, days = 90, viewer = false) {
  const create = viewer
    ? { reusable: false, ephemeral: false, preauthorized: true, tags: [VIEWER_TAG] }
    : { reusable: true, ephemeral: true, preauthorized: true, tags: [TAG] };
  const { json } = await api(token, 'POST', '/tailnet/-/keys', {
    body: { description: viewer ? 'plainsight viewer' : 'plainsight boxes', expirySeconds: days * 86400, capabilities: { devices: { create } } },
  });
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, json.key + '\n', { mode: 0o600 });
  return { id: json.id, expires: json.expires, file };
}

// Turn an existing device (e.g. your phone) into a view-only dashboard device. Tags replace its
// user identity, so it loses its normal access to your other devices.
async function makeViewer(token, name) {
  const { json } = await api(token, 'GET', '/tailnet/-/devices');
  const want = String(name).toLowerCase();
  const hits = (json.devices || []).filter((d) => [d.hostname, d.name, d.name && d.name.split('.')[0], ...(d.addresses || [])].some((v) => v && String(v).toLowerCase() === want));
  if (hits.length !== 1) throw new Error(hits.length ? `"${name}" matches ${hits.length} devices; use its Tailscale IP` : `no device named "${name}"`);
  const d = hits[0];
  await api(token, 'POST', `/device/${d.nodeId || d.id}/tags`, { body: { tags: [VIEWER_TAG] } });
  return { name: d.name, addresses: d.addresses };
}

module.exports = { bootstrap, mintKey, makeViewer, buildPolicy };
