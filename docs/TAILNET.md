# Tailnet setup (pool owner, once)

A **pool** is the set of machines that share usage with each other. It lives inside one Tailscale tailnet (yours). Setting it up takes three things, done once:

1. A **policy** that isolates plainsight machines (`tag:plainsight`) from your other devices.
2. A **Tailscale Service** `svc:plainsight` that publishes the dashboard at one stable tailnet address, hosted by whichever boxes are online.
3. A reusable **auth key** that new boxes use to join, already tagged.

The automated route uses the official [Tailscale API](https://tailscale.com/api) with a short-lived API access token. The manual route uses the admin console. Both give the same result.

---

## Automated (recommended)

1. **Create an API access token.** Admin console → Settings → Keys → *Generate access token*. Use a 7-day expiry. Save it to a private file, e.g. `~/.plainsight/ts-api-token` (`chmod 600`).
2. **Clone plainsight** on any machine: `git clone https://github.com/JayceeGupta/plainsight ~/.plainsight/app`.
3. **Dry run:**
   ```sh
   node ~/.plainsight/app/bin/plainsight.js pool bootstrap --token-file ~/.plainsight/ts-api-token --admin-ip 100.x.y.z
   ```
   - Backs up your current policy to `~/.plainsight/policy-backup-<time>.json`.
   - Writes the proposed policy to `~/.plainsight/policy-proposed.json` and has Tailscale validate it.
   - `--admin-ip` is optional: the Tailscale IP of your own computer (`tailscale ip -4` on it), which gets full access to boxes. See [Admin device](#admin-device).
4. **Apply:** re-run with `--apply`. This saves the policy (with an ETag check, so it never overwrites a concurrent edit) and defines `svc:plainsight`. It prints the service's **TailVIP**.
   - If your policy already has custom rules, bootstrap refuses to apply. Review the proposed file: it keeps your other rules but removes any allow-all grant. Then use `--force`, or merge by hand using the [policy below](#the-policy).
5. **Mint the join key:**
   ```sh
   node ~/.plainsight/app/bin/plainsight.js pool key --token-file ~/.plainsight/ts-api-token
   ```
   Saves a reusable, ephemeral, pre-approved `tag:plainsight` key (90 days) to `~/.plainsight/tailscale-authkey.txt`. It is never printed. Hand it to new boxes privately.
6. **Revoke the API token** (Settings → Keys). You only need a new one to mint the next key.

## Manual (admin console)

1. **Access controls** → JSON editor: back up the current file, then merge in [the policy](#the-policy). Save. Tailscale runs the policy's `tests` and refuses to save if they fail.
2. **Services** → *Define a Service*:
   - Name: `plainsight` (shown as `svc:plainsight`).
   - Ports: `tcp:80`, `tcp:443`.
   - Hosts are approved automatically by the policy's `autoApprovers`.
3. **Settings → Keys → Generate auth key**: Reusable ✓, Ephemeral ✓, Pre-approved ✓, Tags: `tag:plainsight`, expiry up to 90 days.
4. **DNS:** enable MagicDNS and HTTPS Certificates, so `https://plainsight.<tailnet>.ts.net` works.

---

## The policy

[policy/policy.example.hujson](../policy/policy.example.hujson) has a commented copy. The essential parts:

```jsonc
{
  "tagOwners": { "tag:plainsight": ["autogroup:admin"] },
  "hosts": { "plainsight-admin": "100.x.y.z" },            // optional: your own computer
  "grants": [
    // your devices reach each other and the internet (exit nodes), NOT boxes directly
    {"src": ["autogroup:member"], "dst": ["autogroup:member", "autogroup:internet"], "ip": ["*"]},
    // your devices open the dashboard only through the service
    {"src": ["autogroup:member"], "dst": ["svc:plainsight"], "ip": ["tcp:80", "tcp:443"]},
    // boxes reach only each other, only on the sync port
    {"src": ["tag:plainsight"], "dst": ["tag:plainsight"], "ip": ["tcp:4747"]},
    // optional: your computer reaches boxes fully (sync, ssh, debugging)
    {"src": ["plainsight-admin"], "dst": ["tag:plainsight"], "ip": ["*"]}
  ],
  "autoApprovers": { "services": { "svc:plainsight": ["tag:plainsight"] } },
  "tests": [
    {"src": "tag:plainsight", "accept": ["tag:plainsight:4747"], "deny": ["tag:plainsight:22", "100.x.y.z:445"]},
    {"src": "100.x.y.z", "accept": ["tag:plainsight:4747", "tag:plainsight:22"]}
  ]
}
```

### What the policy does

| From | To | Allowed |
|---|---|---|
| Box (`tag:plainsight`) | Other boxes | tcp:4747 only (sync) |
| Box | Your devices, the internet via your exit nodes | Nothing. Boxes cannot even see your devices in `tailscale status`. |
| Your devices | Each other | Everything, as before |
| Your devices | Boxes directly | Nothing |
| Your devices | `svc:plainsight` | tcp:80/443 (the dashboard) |
| `plainsight-admin` (optional) | Boxes | Everything. Boxes can only reply. |

Tailscale shows a device to another only if one may connect to the other. So boxes only see:
- each other
- the admin device, if configured
- for the duration of a visit, the device viewing the dashboard (a host must know who it is serving)

The `tests` block makes Tailscale reject any later policy edit that breaks the isolation.

### Admin device

Your own computer (untagged) can also share its usage. It never accepts connections from boxes; it **dials out** to every online box, pushes its new events and pulls everything it is missing in the same exchange. For that it needs the `plainsight-admin` host and grant. Without them, a personal device can still view the dashboard but cannot share its own usage.

---

## Custom domain

`svc:plainsight` has a fixed tailnet IP (TailVIP). Find it in the admin console → Services, or in the output of `pool bootstrap --apply`.

1. At your DNS provider, add an **A** record `usage.example.com → <TailVIP IPv4>`.
   - Cloudflare: **DNS only** (grey cloud). The proxy cannot reach tailnet IPs.
   - A more specific record overrides a wildcard.
2. Devices on your tailnet load `http://usage.example.com`. Anyone else resolves a `100.x` address that goes nowhere, so the page never loads off-tailnet. Publishing a `100.x` address in public DNS reveals nothing useful.
3. **HTTPS on a custom domain** needs a certificate for that name. `tailscale serve` only has certificates for `*.ts.net`. The plain `http://` URL is still encrypted end to end by WireGuard. If your TLD forces HTTPS (`.dev`, `.app`), use the `https://plainsight.<tailnet>.ts.net` URL instead.

## Plan limits and housekeeping

- **Tagged devices:** every box is one. The free plan was reported in 2026 to allow 50 tagged devices; see [tailscale.com/pricing](https://tailscale.com/pricing).
- **Ephemeral cleanup:** ephemeral boxes are removed automatically soon after they go offline. Their usage history survives on the other machines.
- **Auth key expiry:** 90 days at most. Mint a new one with `pool key`; already-joined boxes are unaffected.
- **Remove a box now:** admin console → Machines → *Remove*, or `tailscale logout` on the box.
- **Rotate everything:** revoke the auth key (Settings → Keys). Existing boxes keep working, and no new box can join until you mint another.
