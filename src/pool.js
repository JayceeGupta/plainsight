'use strict';
// Tailnet owner bootstrap through the official Tailscale API (https://tailscale.com/api).
// Needs an API access token (Admin console > Settings > Keys > Generate access token).
const fs = require('fs');
const { TAG, paths } = require('./util');

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
// Tailscale carries data sharing only. Rules from plainsight 0.1's tailnet dashboard (the
// svc:plainsight service and the tag:plainsight-viewer devices) are removed if present.
const LEGACY_SERVICE = 'svc:plainsight';
const LEGACY_VIEWER = 'tag:plainsight-viewer';

function buildPolicy(cur, adminIp) {
  const grants = cur.grants || [];
  const acls = cur.acls || [];
  const isDefault = grants.every(ALLOW_ALL) && acls.every(ALLOW_ALL_ACL) && (grants.length + acls.length) <= 1 && !cur.groups && !cur.tagOwners;
  const p = { ...cur };
  delete p.acls;
  const owners = { ...(cur.tagOwners || {}), [TAG]: ['autogroup:admin'] };
  delete owners[LEGACY_VIEWER];
  p.tagOwners = owners;
  if (adminIp) p.hosts = { ...(cur.hosts || {}), 'plainsight-admin': adminIp };
  const ours = [
    // your devices reach each other and the internet (exit nodes), NOT boxes directly
    { src: ['autogroup:member'], dst: ['autogroup:member', 'autogroup:internet'], ip: ['*'] },
    // boxes reach only each other, only on the sync port
    { src: [TAG], dst: [TAG], ip: ['tcp:4747'] },
    // your own devices (every untagged machine logged in as a tailnet member) sync by connecting
    // out to boxes on the sync port; boxes cannot initiate back
    { src: ['autogroup:member'], dst: [TAG], ip: ['tcp:4747'] },
  ];
  const mine = new Set(ours.map((g) => JSON.stringify(g)));
  const seen = new Set();
  p.grants = [...grants.filter((g) => !ALLOW_ALL(g) && !JSON.stringify(g).includes('plainsight') && !mine.has(JSON.stringify(g))), ...ours]
    .filter((g) => { const k = JSON.stringify(g); if (seen.has(k)) return false; seen.add(k); return true; });
  if (cur.autoApprovers && cur.autoApprovers.services) {
    const services = { ...cur.autoApprovers.services };
    delete services[LEGACY_SERVICE];
    p.autoApprovers = { ...cur.autoApprovers, services };
    if (!Object.keys(services).length) delete p.autoApprovers.services;
    if (!Object.keys(p.autoApprovers).length) delete p.autoApprovers;
  }
  // keep every existing test (some are added by hand, e.g. 'boxes cannot reach my phone'),
  // except ones about the removed viewer tag or service; add ours if missing
  // Your computer only gets the sync port on boxes, so tests expecting more are adjusted.
  const keep = (cur.tests || [])
    .filter((t) => !JSON.stringify(t).includes(LEGACY_VIEWER) && !JSON.stringify(t).includes(LEGACY_SERVICE))
    .map((t) => (adminIp && t.src === adminIp && Array.isArray(t.accept) ? { ...t, accept: t.accept.filter((d) => d !== `${TAG}:22`) } : t));
  // drop a test when another test for the same source already checks everything it checks
  const covers = (big, small) => big !== small && big.src === small.src
    && (small.accept || []).every((d) => (big.accept || []).includes(d)) && (small.deny || []).every((d) => (big.deny || []).includes(d))
    && JSON.stringify(Object.keys(small).filter((k) => !['src', 'accept', 'deny'].includes(k))) === '[]';
  const seenT = new Set();
  p.tests = keep
    .filter((t) => { const k = JSON.stringify(t); if (seenT.has(k)) return false; seenT.add(k); return true; })
    .filter((t, i, all) => !all.some((o, j) => covers(o, t) && (JSON.stringify(o) !== JSON.stringify(t) || j < i)));
  // add ours only when no existing test already covers that source
  for (const t of [
    { src: TAG, accept: [`${TAG}:4747`], deny: [`${TAG}:22`, ...(adminIp ? [`${adminIp}:445`] : [])] },
    ...(adminIp ? [{ src: adminIp, accept: [`${TAG}:4747`], deny: [`${TAG}:22`] }] : []),
  ]) if (!p.tests.some((x) => x.src === t.src)) p.tests.push(t);
  return { policy: p, isDefault };
}

async function bootstrap(token, { adminIp, apply, force }) {
  const out = [];
  const { json: cur, etag } = await api(token, 'GET', '/tailnet/-/acl');
  // Old-style "acls" rules cannot be merged automatically; never drop them silently.
  const customAcls = (cur.acls || []).filter((a) => !ALLOW_ALL_ACL(a));
  if (customAcls.length) {
    out.push(`Your policy uses ${customAcls.length} old-style "acls" rule(s). plainsight only writes "grants" and will not drop or rewrite them, so nothing was changed.`);
    out.push('Merge by hand: add the grants from policy/policy.example.hujson to your policy (docs/TAILNET.md, "Manual"), or convert your acls to grants first.');
    return { out, applied: false };
  }
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
    out.push('Your policy has custom rules, so it was NOT applied. Review the proposed file: it keeps your other grants, ssh, nodeAttrs, hosts and tests, removes an allow-all grant if there is one (that is what isolates boxes), and adds the plainsight grants. Then re-run with --apply --force, or merge by hand (docs/TAILNET.md).');
    return { out, applied: false };
  }
  if (!apply) { out.push('Dry run. Re-run with --apply to save it.'); return { out, applied: false }; }
  await api(token, 'POST', '/tailnet/-/acl', { body: policy, headers: etag ? { 'if-match': etag } : {} });
  out.push('Policy applied.');
  try {
    await api(token, 'DELETE', `/tailnet/-/vip-services/${LEGACY_SERVICE}`);
    out.push(`Removed the old dashboard service ${LEGACY_SERVICE} (the dashboard now goes through Cloudflare).`);
  } catch (e) { if (!/HTTP 404/.test(e.message)) out.push(`Could not remove ${LEGACY_SERVICE}: ${e.message}`); }
  return { out, applied: true };
}

// Reusable, pre-approved key for boxes. Not ephemeral by default: Tailscale deletes ephemeral
// devices soon after they go offline, so a box that is off for a weekend would have to rejoin.
async function mintKey(token, file, days = 90, ephemeral = false) {
  const { json } = await api(token, 'POST', '/tailnet/-/keys', {
    body: { description: 'plainsight boxes', expirySeconds: days * 86400, capabilities: { devices: { create: { reusable: true, ephemeral, preauthorized: true, tags: [TAG] } } } },
  });
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, json.key + '\n', { mode: 0o600 });
  return { id: json.id, expires: json.expires, file };
}

module.exports = { bootstrap, mintKey, buildPolicy };
