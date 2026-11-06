'use strict';
// Owner-side Cloudflare setup for the dashboard, through the official API (https://developers.cloudflare.com/api/).
//
//   visitor ─https─► Cloudflare Access (login) ─► Worker "plainsight-gate" ─► Tunnel "plainsight"
//                                                  (shows "no machine online"     │  any connector
//                                                   when no connector is up)      ▼  that is up
//                                                                    cloudflared on your computer / boxes
//                                                                    ─► 127.0.0.1:4749 (read-only view)
//
// Every step is idempotent: re-running setup repairs or updates, it never duplicates.
// The API token is only used while a command runs; it is never written anywhere by plainsight.
const fs = require('fs');

const API = 'https://api.cloudflare.com/client/v4';
const NAMES = { tunnel: 'plainsight', app: 'plainsight', policy: 'plainsight viewers', worker: 'plainsight-gate', otp: 'Email code', google: 'Google' };
const VIEW_SERVICE = (port) => `http://127.0.0.1:${port}`;
const WORKER_PATTERNS = (h) => [`${h}/`, `${h}/index.html`];

function readToken(opt) {
  const tf = opt['token-file'];
  if (tf && tf !== true) return fs.readFileSync(tf, 'utf8').trim();
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN.trim();
  throw new Error('a Cloudflare API token is needed: --token-file FILE or CLOUDFLARE_API_TOKEN (never pass the token itself as an argument)');
}

function client(token) {
  return async function cf(method, path, body, { raw = false } = {}) {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body && !isForm ? { 'content-type': 'application/json' } : {}) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) {
      const err = new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status} ${(j.errors || []).map((e) => `${e.code} ${e.message}`).join('; ').slice(0, 300)}`);
      err.status = res.status;
      err.codes = (j.errors || []).map((e) => e.code);
      throw err;
    }
    return raw ? j : j.result;
  };
}

async function account(cf, want) {
  const accts = await cf('GET', '/accounts?per_page=50');
  if (want) { const a = accts.find((x) => x.id === want); if (!a) throw new Error(`account ${want} not visible to this token`); return a; }
  if (accts.length !== 1) throw new Error(`token sees ${accts.length} accounts; pass --account ID (${accts.map((a) => `${a.id} ${a.name}`).join(', ')})`);
  return accts[0];
}

async function zoneFor(cf, hostname) {
  const parts = hostname.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const zs = await cf('GET', `/zones?name=${encodeURIComponent(parts.slice(i).join('.'))}`);
    if (zs.length) return zs[0];
  }
  throw new Error(`no Cloudflare zone for ${hostname} is visible to this token`);
}

async function org(cf, a) {
  try { return await cf('GET', `/accounts/${a}/access/organizations`); }
  catch (e) {
    if (e.status === 404 || e.status === 400 || /not_enabled|not enabled/i.test(e.message)) throw new Error('Cloudflare Zero Trust is not set up on this account yet. Open https://one.dash.cloudflare.com once, pick a team name and the Free plan, then re-run.');
    throw e;
  }
}

// ---------------------------------------------------------------- pieces
async function ensureTunnel(cf, a, hostname, viewPort) {
  let t = (await cf('GET', `/accounts/${a}/cfd_tunnel?name=${NAMES.tunnel}&is_deleted=false`))[0];
  if (!t) t = await cf('POST', `/accounts/${a}/cfd_tunnel`, { name: NAMES.tunnel, config_src: 'cloudflare' });
  await cf('PUT', `/accounts/${a}/cfd_tunnel/${t.id}/configurations`, {
    config: { ingress: [{ hostname, service: VIEW_SERVICE(viewPort), originRequest: {} }, { service: 'http_status:404' }] },
  });
  return t;
}

async function tunnelToken(cf, a, tunnelId) {
  return cf('GET', `/accounts/${a}/cfd_tunnel/${tunnelId}/token`);
}

async function ensureDns(cf, z, hostname, tunnelId) {
  const target = `${tunnelId}.cfargotunnel.com`;
  const recs = await cf('GET', `/zones/${z}/dns_records?name=${encodeURIComponent(hostname)}`);
  const other = recs.find((r) => !['A', 'AAAA', 'CNAME'].includes(r.type));
  if (other) throw new Error(`${hostname} has a ${other.type} record; remove it first (nothing was changed)`);
  const previous = recs.map((r) => ({ type: r.type, content: r.content, proxied: r.proxied }));
  const ok = recs.length === 1 && recs[0].type === 'CNAME' && recs[0].content === target && recs[0].proxied;
  if (!ok) {
    for (const r of recs) await cf('DELETE', `/zones/${z}/dns_records/${r.id}`);
    await cf('POST', `/zones/${z}/dns_records`, { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1, comment: 'plainsight dashboard (Cloudflare Tunnel)' });
  }
  return { changed: !ok, previous };
}

async function ensureIdps(cf, a, google) {
  const idps = await cf('GET', `/accounts/${a}/access/identity_providers`);
  let otp = idps.find((i) => i.type === 'onetimepin');
  if (!otp) otp = await cf('POST', `/accounts/${a}/access/identity_providers`, { name: NAMES.otp, type: 'onetimepin', config: {} });
  let g = idps.find((i) => i.type === 'google' && i.name === NAMES.google) || idps.find((i) => i.type === 'google');
  if (google) {
    const body = { name: NAMES.google, type: 'google', config: { client_id: google.clientId, client_secret: google.clientSecret } };
    g = g ? await cf('PUT', `/accounts/${a}/access/identity_providers/${g.id}`, body) : await cf('POST', `/accounts/${a}/access/identity_providers`, body);
  }
  return { otp, google: g || null };
}

function rules(emails, domains) {
  return [...emails.map((email) => ({ email: { email } })), ...domains.map((domain) => ({ email_domain: { domain } }))];
}

async function ensurePolicy(cf, a, emails, domains, existingId) {
  const body = { name: NAMES.policy, decision: 'allow', include: rules(emails, domains), exclude: [], require: [] };
  if (!body.include.length) throw new Error('at least one allowed email or email domain is required');
  if (existingId) { try { return await cf('PUT', `/accounts/${a}/access/policies/${existingId}`, body); } catch (e) { if (e.status !== 404) throw e; } }
  const found = (await cf('GET', `/accounts/${a}/access/policies?per_page=100`)).find((p) => p.name === NAMES.policy);
  return found ? cf('PUT', `/accounts/${a}/access/policies/${found.id}`, body) : cf('POST', `/accounts/${a}/access/policies`, body);
}

async function ensureApp(cf, a, hostname, { policyId, idps, session }) {
  const body = {
    name: NAMES.app, type: 'self_hosted', domain: hostname, destinations: [{ type: 'public', uri: hostname }],
    session_duration: session, allowed_idps: idps, auto_redirect_to_identity: idps.length === 1,
    app_launcher_visible: false, policies: [{ id: policyId, precedence: 1 }],
  };
  const apps = await cf('GET', `/accounts/${a}/access/apps?per_page=100`);
  const app = apps.find((x) => x.domain === hostname || x.name === NAMES.app && (x.domain || '').startsWith(hostname));
  return app ? cf('PUT', `/accounts/${a}/access/apps/${app.id}`, body) : cf('POST', `/accounts/${a}/access/apps`, body);
}

function gateWorker() {
  return fs.readFileSync(require('path').join(__dirname, '..', 'web', 'gate-worker.js'), 'utf8');
}

async function ensureWorker(cf, a, z, hostname) {
  const fd = new FormData();
  fd.append('metadata', JSON.stringify({ main_module: 'worker.js', compatibility_date: '2025-06-01' }));
  fd.append('worker.js', new Blob([gateWorker()], { type: 'application/javascript+module' }), 'worker.js');
  await cf('PUT', `/accounts/${a}/workers/scripts/${NAMES.worker}`, fd);
  // Only the page itself runs through the Worker (1 request per visit). The dashboard's data calls
  // go straight to the tunnel, so the free Workers allowance (100,000 requests/day) is never close.
  const routes = await cf('GET', `/zones/${z}/workers/routes`);
  for (const old of routes.filter((x) => x.pattern === `${hostname}/*` && x.script === NAMES.worker)) await cf('DELETE', `/zones/${z}/workers/routes/${old.id}`);
  for (const pattern of WORKER_PATTERNS(hostname)) {
    const r = routes.find((x) => x.pattern === pattern);
    if (!r) await cf('POST', `/zones/${z}/workers/routes`, { pattern, script: NAMES.worker });
    else if (r.script !== NAMES.worker) await cf('PUT', `/zones/${z}/workers/routes/${r.id}`, { pattern, script: NAMES.worker });
  }
}

// Dark login page, only when this account has no other Access apps (the design is account-wide).
async function styleLogin(cf, a, o) {
  const apps = await cf('GET', `/accounts/${a}/access/apps?per_page=100`);
  if (apps.some((x) => x.name !== NAMES.app)) return false;
  await cf('PUT', `/accounts/${a}/access/organizations`, {
    name: o.name, auth_domain: o.auth_domain,
    login_design: { background_color: '#000000', text_color: '#f5f5f5', footer_text: 'plainsight · usage dashboard' },
  });
  return true;
}

// ---------------------------------------------------------------- commands
async function setup(token, o) {
  const cf = client(token);
  const out = [];
  const a = await account(cf, o.account);
  const z = await zoneFor(cf, o.hostname);
  const organization = await org(cf, a.id);
  let emails = o.emails;
  let domains = o.domains;
  // re-running setup keeps who may sign in, how, and for how long, unless told otherwise
  let kept = null;
  if (o.prev && o.prev.appId && o.prev.accountId === a.id) {
    try {
      const [app0, pol0] = await Promise.all([cf('GET', `/accounts/${a.id}/access/apps/${o.prev.appId}`), cf('GET', `/accounts/${a.id}/access/policies/${o.prev.policyId}`)]);
      kept = { idps: app0.allowed_idps || [], session: app0.session_duration, emails: (pol0.include || []).filter((r) => r.email).map((r) => r.email.email), domains: (pol0.include || []).filter((r) => r.email_domain).map((r) => r.email_domain.domain) };
      if (!emails.length && !domains.length) { emails = kept.emails; domains = kept.domains; }
    } catch {}
  }
  const session = o.session || (kept && kept.session) || '720h';
  if (!emails.length && !domains.length) {
    try { emails = [(await cf('GET', '/user')).email]; out.push(`Allowed: ${emails[0]} (this Cloudflare account's email; change with plainsight access add/remove)`); }
    catch { throw new Error('pass --email you@example.com (the token cannot read your Cloudflare user email)'); }
  }
  const t = await ensureTunnel(cf, a.id, o.hostname, o.viewPort);
  out.push(`Tunnel "${NAMES.tunnel}" ${t.id} -> ${VIEW_SERVICE(o.viewPort)}`);
  const tok = await tunnelToken(cf, a.id, t.id);
  fs.writeFileSync(o.tunnelTokenFile, tok + '\n', { mode: 0o600 });
  out.push(`Tunnel token saved to ${o.tunnelTokenFile} (never printed)`);
  const google = o.google ? { clientId: o.google.clientId, clientSecret: fs.readFileSync(o.google.secretFile, 'utf8').trim() } : null;
  const idps = await ensureIdps(cf, a.id, google);
  const policy = await ensurePolicy(cf, a.id, emails, domains, o.prev && o.prev.policyId);
  const valid = new Set([idps.otp.id, ...(idps.google ? [idps.google.id] : [])]);
  const idpIds = !google && kept && kept.idps.length && kept.idps.every((i) => valid.has(i)) ? kept.idps : [...valid];
  const app = await ensureApp(cf, a.id, o.hostname, { policyId: policy.id, idps: idpIds, session });
  out.push(`Access app on https://${o.hostname}: ${idpIds.map((i) => (idps.google && i === idps.google.id ? 'Google' : 'emailed code')).join(' or ')}, sessions ${session}; allowed: ${[...emails, ...domains.map((d) => '@' + d)].join(', ')}`);
  await ensureWorker(cf, a.id, z.id, o.hostname);
  out.push(`Worker "${NAMES.worker}" on the page of ${o.hostname} (shows "no machine online" when no connector is up)`);
  const dns = await ensureDns(cf, z.id, o.hostname, t.id);
  out.push(dns.changed ? `DNS ${o.hostname} -> tunnel (replaced: ${JSON.stringify(dns.previous)})` : `DNS ${o.hostname} already points at the tunnel`);
  if (await styleLogin(cf, a.id, organization).catch(() => false)) out.push('Login page styled dark (no other Access apps on this account)');
  if (!idps.google) out.push(`Google sign-in: create an OAuth client with redirect URI https://${organization.auth_domain}/cdn-cgi/access/callback, then run: plainsight access google --client-id ID --client-secret-file FILE`);
  return {
    out,
    conf: { accountId: a.id, zoneId: z.id, hostname: o.hostname, tunnelId: t.id, appId: app.id, policyId: policy.id, authDomain: organization.auth_domain, session },
  };
}

async function status(token, c) {
  const cf = client(token);
  const [app, policy, conns, idps] = await Promise.all([
    cf('GET', `/accounts/${c.accountId}/access/apps/${c.appId}`),
    cf('GET', `/accounts/${c.accountId}/access/policies/${c.policyId}`),
    cf('GET', `/accounts/${c.accountId}/cfd_tunnel/${c.tunnelId}/connections`),
    cf('GET', `/accounts/${c.accountId}/access/identity_providers`),
  ]);
  const idpName = Object.fromEntries(idps.map((i) => [i.id, i.type === 'onetimepin' ? 'emailed code' : i.type === 'google' ? 'Google' : i.name]));
  return {
    url: `https://${c.hostname}`,
    login: (app.allowed_idps || []).map((i) => idpName[i] || i),
    session: app.session_duration,
    emails: (policy.include || []).filter((r) => r.email).map((r) => r.email.email),
    domains: (policy.include || []).filter((r) => r.email_domain).map((r) => r.email_domain.domain),
    connectors: (conns || []).map((x) => ({ id: x.id, version: x.version || x.client_version, arch: x.arch, since: x.run_at, edges: (x.conns || []).length, ip: x.origin_ip })),
    googleConfigured: idps.some((i) => i.type === 'google'),
  };
}

async function setAccess(token, c, { emails, domains }) {
  const cf = client(token);
  return ensurePolicy(cf, c.accountId, emails, domains, c.policyId);
}

async function setApp(token, c, patch) {
  const cf = client(token);
  const app = await cf('GET', `/accounts/${c.accountId}/access/apps/${c.appId}`);
  const body = {
    name: app.name, type: app.type, domain: app.domain, destinations: app.destinations, session_duration: app.session_duration,
    allowed_idps: app.allowed_idps, auto_redirect_to_identity: app.auto_redirect_to_identity, app_launcher_visible: app.app_launcher_visible,
    policies: (app.policies || []).map((p) => ({ id: p.id, precedence: p.precedence })), ...patch,
  };
  body.auto_redirect_to_identity = body.allowed_idps.length === 1;
  return cf('PUT', `/accounts/${c.accountId}/access/apps/${c.appId}`, body);
}

async function setLogin(token, c, which) {
  const cf = client(token);
  const idps = await cf('GET', `/accounts/${c.accountId}/access/identity_providers`);
  const otp = idps.find((i) => i.type === 'onetimepin');
  const g = idps.find((i) => i.type === 'google' && i.name === NAMES.google) || idps.find((i) => i.type === 'google');
  if (which !== 'code' && !g) throw new Error('Google sign-in is not configured yet: plainsight access google --client-id ID --client-secret-file FILE');
  const ids = which === 'google' ? [g.id] : which === 'code' ? [otp.id] : [otp.id, g.id];
  return setApp(token, c, { allowed_idps: ids });
}

async function setGoogle(token, c, clientId, secretFile) {
  const cf = client(token);
  const { otp, google } = await ensureIdps(cf, c.accountId, { clientId, clientSecret: fs.readFileSync(secretFile, 'utf8').trim() });
  await setApp(token, c, { allowed_idps: [otp.id, google.id] });
  return google;
}

async function revoke(token, c, email) {
  const cf = client(token);
  if (email) return cf('POST', `/accounts/${c.accountId}/access/organizations/revoke_user`, { email });
  return cf('POST', `/accounts/${c.accountId}/access/apps/${c.appId}/revoke_tokens`);
}

async function fetchTunnelToken(token, c) {
  return tunnelToken(client(token), c.accountId, c.tunnelId);
}

// Undo everything setup created. Leaves identity providers (they may serve other apps) and Zero Trust itself.
async function teardown(token, c) {
  const cf = client(token);
  const out = [];
  const step = async (what, fn) => { try { await fn(); out.push(`removed ${what}`); } catch (e) { out.push(`${what}: ${e.message}`); } };
  await step('worker routes', async () => {
    for (const r of await cf('GET', `/zones/${c.zoneId}/workers/routes`)) {
      if (r.script === NAMES.worker && r.pattern.startsWith(`${c.hostname}/`)) await cf('DELETE', `/zones/${c.zoneId}/workers/routes/${r.id}`);
    }
  });
  await step(`worker ${NAMES.worker}`, () => cf('DELETE', `/accounts/${c.accountId}/workers/scripts/${NAMES.worker}`));
  await step('Access app', () => cf('DELETE', `/accounts/${c.accountId}/access/apps/${c.appId}`));
  await step('Access policy', () => cf('DELETE', `/accounts/${c.accountId}/access/policies/${c.policyId}`));
  await step(`DNS record ${c.hostname}`, async () => {
    for (const r of await cf('GET', `/zones/${c.zoneId}/dns_records?name=${encodeURIComponent(c.hostname)}`)) {
      if (r.type === 'CNAME' && r.content === `${c.tunnelId}.cfargotunnel.com`) await cf('DELETE', `/zones/${c.zoneId}/dns_records/${r.id}`);
    }
  });
  await step(`tunnel ${NAMES.tunnel}`, async () => {
    try { await cf('DELETE', `/accounts/${c.accountId}/cfd_tunnel/${c.tunnelId}/connections`); } catch {}
    await cf('DELETE', `/accounts/${c.accountId}/cfd_tunnel/${c.tunnelId}`);
  });
  return out;
}

module.exports = { readToken, setup, status, setAccess, setLogin, setGoogle, setApp, revoke, fetchTunnelToken, teardown, NAMES };
