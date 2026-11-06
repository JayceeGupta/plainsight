# Tailnet setup (pool owner, once)

A **pool** is the set of machines that share usage with each other. It lives inside one Tailscale tailnet (yours). Tailscale is used for one thing only: **carrying usage data between machines**. The dashboard does not go through Tailscale; it goes through Cloudflare ([DASHBOARD.md](DASHBOARD.md)).

Setting up the tailnet takes two things, done once:

1. A **policy** that isolates plainsight machines (`tag:plainsight`, "boxes") from your other devices and lets them reach each other only on the sync port.
2. A reusable **auth key** that new boxes use to join, already tagged.

The automated route uses the official [Tailscale API](https://tailscale.com/api) with a short-lived API access token. The manual route uses the admin console. Both give the same result.

---

## Automated (recommended)

1. **Create an API access token.** Admin console → Settings → Keys → *Generate access token*. Use a short expiry (e.g. 7 days). Save it to a private file, e.g. `~/.plainsight/ts-api-token` (`chmod 600`).
2. **Clone plainsight** on any machine: `git clone https://github.com/JayceeGupta/plainsight ~/.plainsight/app`.
3. **Dry run:**
   ```sh
   node ~/.plainsight/app/bin/plainsight.js pool bootstrap --token-file ~/.plainsight/ts-api-token --admin-ip 100.x.y.z
   ```
   - Backs up your current policy to `~/.plainsight/policy-backup-<time>.json`.
   - Writes the proposed policy to `~/.plainsight/policy-proposed.json` and has Tailscale validate it.
   - `--admin-ip` is optional: the Tailscale IP of your own computer (`tailscale ip -4` on it). See [Admin device](#admin-device).
4. **Apply:** re-run with `--apply`. This saves the policy with an ETag check, so it never overwrites a concurrent edit.
   - If your policy is not Tailscale's untouched default (including a policy an earlier plainsight bootstrap wrote), bootstrap refuses to apply. Review the proposed file, then re-run with `--apply --force`, or merge by hand using [the policy below](#the-policy).
   - After applying, bootstrap deletes the old `svc:plainsight` Tailscale Service if it exists (left by plainsight 0.1).
5. **Mint the join key:**
   ```sh
   node ~/.plainsight/app/bin/plainsight.js pool key --token-file ~/.plainsight/ts-api-token
   ```
   Saves a reusable, ephemeral, pre-approved `tag:plainsight` key to `~/.plainsight/tailscale-authkey.txt` (mode 600). It is never printed. `--out FILE` picks another file; `--days N` sets the expiry (default 90, Tailscale's maximum). Hand the key to new boxes privately.
6. **Revoke the API token** (Settings → Keys). You only need a new one to mint the next key or change the policy again.

### What bootstrap changes in your policy

| Part | What bootstrap does |
|---|---|
| `tagOwners` | Adds `tag:plainsight: ["autogroup:admin"]`. Removes `tag:plainsight-viewer` (0.1). Keeps your other tags |
| `hosts` | Adds `plainsight-admin` when you pass `--admin-ip`. Keeps your other hosts |
| `acls` | Removed. The policy uses `grants` only. Merge any legacy `acls` rules into grants by hand before using `--force` |
| `grants` | Removes the allow-all grant and every grant that mentions `plainsight`, then adds the three grants below. Keeps your other grants |
| `autoApprovers` | Removes the `svc:plainsight` entry (0.1). Keeps everything else |
| `tests` | Keeps every existing test except ones about `svc:plainsight` or `tag:plainsight-viewer`. Adds plainsight's tests if missing |
| everything else (`ssh`, `nodeAttrs`, `groups`, …) | Unchanged |

## Manual (admin console)

1. **Access controls** → JSON editor: back up the current file, then merge in [the policy](#the-policy). Save. Tailscale runs the policy's `tests` and refuses to save if they fail.
2. **Settings → Keys → Generate auth key**: Reusable ✓, Ephemeral ✓, Pre-approved ✓, Tags: `tag:plainsight`, expiry up to 90 days.

MagicDNS and HTTPS certificates are not needed. Sync uses tailnet IPs directly.

---

## The policy

[policy/policy.example.hujson](../policy/policy.example.hujson) has a commented copy. The essential parts:

```jsonc
{
  "tagOwners": { "tag:plainsight": ["autogroup:admin"] },
  "hosts": { "plainsight-admin": "100.x.y.z" },            // optional: your own computer
  "grants": [
    // your devices reach each other and the internet (exit nodes), NOT boxes
    {"src": ["autogroup:member"], "dst": ["autogroup:member", "autogroup:internet"], "ip": ["*"]},
    // boxes reach only each other, only on the sync port
    {"src": ["tag:plainsight"], "dst": ["tag:plainsight"], "ip": ["tcp:4747"]},
    // optional: your computer reaches boxes (sync by dialing out, ssh, debugging)
    {"src": ["plainsight-admin"], "dst": ["tag:plainsight"], "ip": ["tcp:4747"]}
  ],
  "tests": [
    {"src": "tag:plainsight", "accept": ["tag:plainsight:4747"], "deny": ["tag:plainsight:22", "100.x.y.z:445"]},
    {"src": "100.x.y.z", "accept": ["tag:plainsight:4747"], "deny": ["tag:plainsight:22"]}
  ]
}
```

### What the policy does

| From | To | Allowed |
|---|---|---|
| Box (`tag:plainsight`) | Other boxes | tcp:4747 only (sync) |
| Box | Your devices, the internet via your exit nodes | Nothing. Boxes cannot even see your devices in `tailscale status` |
| Your devices | Each other | Everything, as before |
| Your devices | Boxes | Nothing |
| `plainsight-admin` (optional) | Boxes | tcp:4747 only (it syncs by dialing out). Boxes can only reply |

Tailscale shows a device to another only if one may connect to the other. So boxes only see each other and, if configured, the admin device.

The `tests` block makes Tailscale reject any later policy edit that breaks the isolation. Add your own, e.g. `{"src": "tag:plainsight", "deny": ["<your-phone-ip>:443"]}`; bootstrap keeps them.

### Admin device

Your own computer stays untagged (a normal device logged in as you). It can still share its usage: it never accepts connections from boxes; it **dials out** to every online box, pushes its new events and pulls everything it is missing in the same exchange. For that it needs the `plainsight-admin` host and grant (`--admin-ip`). Without them it cannot reach boxes, so it only has its own usage.

Your phone needs nothing here. It opens the dashboard at `https://<hostname>` through Cloudflare, with or without Tailscale.

---

## Upgrading from plainsight 0.1

plainsight 0.1 also published the dashboard inside the tailnet: a Tailscale Service `svc:plainsight` on boxes, `https://<computer>.<tailnet>.ts.net:4748` and raw `tcp:80` on your computer, a custom-domain follower (`plainsight dns`) and view-only devices (`tag:plainsight-viewer`). All of that is gone.

1. **Update every machine:** `plainsight update`. On start, the daemon removes the `tailscale serve` entries that point at its own ports (4748, 4749) and its `svc:plainsight` serve config. Entries for anything else are left alone.
   - Linux without Tailscale operator rights: the removal fails and `daemon.log` shows `could not remove tailscale serve ...`. Run the command it names with `sudo` once.
2. **Rewrite the policy:** `pool bootstrap --token-file F --admin-ip IP` (dry run), then add `--apply --force`. The old policy is not the default, so `--force` is needed. This removes the service grants, the viewer tag and its grants, the service auto-approver and their tests, and deletes `svc:plainsight`.
3. **Remove view-only devices:** admin console → Machines → the device → *Remove*. Phones now use the Cloudflare URL and need no Tailscale.
4. **Custom domain:** if you used one with `plainsight dns`, give the same hostname to `plainsight cloudflare setup --hostname`. It replaces the old A record with the tunnel record ([DASHBOARD.md](DASHBOARD.md)).
5. Old config keys (`hostService`, `serveTailnet`, `tailnetPort`, `tailnetHttpPort`, `dns`) are ignored. You can delete them from `config.json`.
6. Set up the dashboard: [DASHBOARD.md](DASHBOARD.md).

---

## Plan limits and housekeeping

- **Tagged devices:** every box is one. The free Personal plan was reported in 2026 to allow 50 tagged devices; see [tailscale.com/pricing](https://tailscale.com/pricing).
- **Ephemeral cleanup:** ephemeral boxes are removed automatically soon after they go offline. Their usage history survives on the other machines.
- **Auth key expiry:** 90 days at most. Mint a new one with `pool key`; already-joined boxes are unaffected.
- **Remove a box now:** admin console → Machines → *Remove*, or `tailscale logout` on the box. Also run `plainsight tunnel leave` on it, or it keeps serving the dashboard over the internet ([DASHBOARD.md](DASHBOARD.md#removing-a-machine)).
- **Rotate the join key:** revoke it (Settings → Keys). Existing boxes keep working, and no new box can join until you mint another.
