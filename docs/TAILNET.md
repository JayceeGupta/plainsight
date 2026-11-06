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

## View-only devices (phones)

There are two ways to look at the dashboard from a phone. Pick one per device.

| | Your own phone, as it is | View-only device (`tag:plainsight-viewer`) |
|---|---|---|
| Who | A device logged into Tailscale as you | Your phone, or someone else's |
| Can open the dashboard | Yes | Yes |
| Can reach anything else | Your other devices, as before | Nothing |
| Can be reached | By your other devices, as before | By nothing |
| Setup | None | One command (needs an API token) |

Either way the dashboard is **read-only**: requests that come through Tailscale cannot announce, stop or change anything.

The dashboard is at:
- `https://plainsight.<tailnet>.ts.net` while a box is online, and
- `https://<your-computer>.<tailnet>.ts.net:4748` while your computer is on. The daemon on any untagged machine publishes this automatically, tailnet-only. `plainsight url` prints both.

### Make an existing device view-only

```sh
# the policy must include the viewer rules: re-run bootstrap once after updating plainsight
node ~/.plainsight/app/bin/plainsight.js pool bootstrap --token-file ~/.plainsight/ts-api-token --admin-ip 100.x.y.z --apply --force
node ~/.plainsight/app/bin/plainsight.js pool viewer <device-name-or-tailscale-ip> --token-file ~/.plainsight/ts-api-token
```

The device is re-tagged `tag:plainsight-viewer`. **A tagged device stops being "yours" in Tailscale**: it loses access to your other devices and to exit nodes. Only do this to a phone that should do nothing but view the dashboard. Undo: admin console → Machines → the device → *Edit ACL tags* → remove the tag.

### Add someone else's phone (view-only)

1. Mint a single-use viewer key (30 days by default, `--days N` to change):
   ```sh
   node ~/.plainsight/app/bin/plainsight.js pool key --viewer --token-file ~/.plainsight/ts-api-token
   ```
   It is saved to `~/.plainsight/tailscale-viewer-key.txt` and never printed.
2. Send the key privately. On the phone, install Tailscale and log in **with the auth key** instead of an account. On Android: sign-in screen → ⋮ menu → *Use an auth key*. If the app offers no auth-key login, invite the person to your tailnet as a user instead and run `pool viewer` on their device.
3. Open `https://plainsight.<tailnet>.ts.net` (or your computer's address) and *Add to Home screen*.
4. Remove access any time: admin console → Machines → the device → *Remove*.

Each key joins exactly one device. Viewer devices are not ephemeral, so they stay listed while offline.

---

## Custom domain

A custom name like `usage.example.com` only ever resolves to a `100.x` tailnet address, so it loads only for devices on your tailnet. Anyone else gets an address that goes nowhere. Publishing it in public DNS reveals nothing useful.

**Where it should point:**

| Situation | Point it at | Who can open it |
|---|---|---|
| At least one box is online | The service TailVIP (admin console → Services, or the output of `pool bootstrap --apply`) | Your devices, view-only devices, boxes |
| No box online, your computer is on | Your computer's tailnet IP (`tailscale ip -4`) | Your devices, view-only devices |

A DNS name holds one address, and both are needed at different times. Listing both does not work: an address with no host behind it hangs for about 20 seconds instead of failing, so half of all loads would stall. Instead, let your computer move the record automatically.

### Automatic (Cloudflare)

1. Create the record once: **A** `usage.example.com` → any `100.x` address, **DNS only** (grey cloud; Cloudflare's proxy cannot reach tailnet IPs). A more specific record overrides a wildcard.
2. Create a Cloudflare API token: My Profile → API Tokens → *Create Token* → template **Edit zone DNS** → Zone Resources: *Specific zone* → your domain. Save it to `~/.plainsight/cloudflare-token` (private file).
3. On your own (untagged) computer:
   ```sh
   node ~/.plainsight/app/bin/plainsight.js dns usage.example.com --token-file ~/.plainsight/cloudflare-token --service-ip <TailVIP>
   node ~/.plainsight/app/bin/plainsight.js update
   ```
4. Every minute, while that computer is on, it checks whether the service answers:
   - If it does (a box is hosting), the record points at the TailVIP.
   - If it fails twice in a row, the record points at the computer itself.

   TTL is 60 seconds. `daemon.log` shows each switch. Turn it off with `plainsight dns off`.

Limitation: if your computer goes offline while the record points at it, the record stays there until the computer is back. In that time, use `https://plainsight.<tailnet>.ts.net`, which always reaches whichever box is online.

### How each host answers on a custom name

- **Boxes:** host the service with `https:443` (for the `ts.net` name) and raw `tcp:80` forwarding (for custom names).
- **Your computer:** publishes `tcp:80` on its own tailnet IP.
- Raw TCP forwarding matters because `tailscale serve`'s HTTP proxy only answers for `*.ts.net` names and returns 404 for anything else.
- Every published port leads to a separate read-only listener, so no request from the tailnet can change anything.

**HTTPS on a custom name** needs a certificate for that name, and `tailscale serve` only has certificates for `*.ts.net`. Use `http://usage.example.com`; the traffic is still encrypted end to end by WireGuard. If your TLD forces HTTPS (`.dev`, `.app`), use the `https://plainsight.<tailnet>.ts.net` URL instead.

## Plan limits and housekeeping

- **Tagged devices:** every box is one. The free plan was reported in 2026 to allow 50 tagged devices; see [tailscale.com/pricing](https://tailscale.com/pricing).
- **Ephemeral cleanup:** ephemeral boxes are removed automatically soon after they go offline. Their usage history survives on the other machines.
- **Auth key expiry:** 90 days at most. Mint a new one with `pool key`; already-joined boxes are unaffected.
- **Remove a box now:** admin console → Machines → *Remove*, or `tailscale logout` on the box.
- **Rotate everything:** revoke the auth key (Settings → Keys). Existing boxes keep working, and no new box can join until you mint another.
