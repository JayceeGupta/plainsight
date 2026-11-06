# Tailnet setup (pool owner, once)

A **pool** is the set of machines that share usage with each other. It lives inside one Tailscale tailnet (yours). Tailscale is used for one thing only: **carrying usage data between machines**. The dashboard does not go through Tailscale; it goes through Cloudflare ([DASHBOARD.md](DASHBOARD.md)).

Setting up the tailnet takes two things, done once:

1. A **policy** that isolates plainsight machines (`tag:plainsight`, "boxes") from your other devices, lets boxes reach each other only on the sync port, and lets your own devices connect out to boxes on that port.
2. A reusable **auth key** that new boxes use to join, already tagged.

**At least one box is required.** Only boxes accept sync connections. Your personal (untagged) machines connect out to boxes and never to each other, so with no box nothing is shared.

The automated route uses the official [Tailscale API](https://tailscale.com/api) with a short-lived API access token. The manual route uses the admin console. Both give the same result.

---

## Automated (recommended)

1. **Create an API access token.** Admin console → Settings → Keys → *Generate access token*. Use a short expiry (e.g. 7 days). Save it to a private file, e.g. `~/.plainsight/ts-api-token` (macOS/Linux: `chmod 600 ~/.plainsight/ts-api-token`; Windows: a file in your own user folder is private to you).
2. **Clone plainsight** on any machine:
   ```sh
   # macOS / Linux
   git clone https://github.com/JayceeGupta/plainsight ~/.plainsight/app
   ```
   ```powershell
   # Windows PowerShell
   git clone https://github.com/JayceeGupta/plainsight "$env:USERPROFILE\.plainsight\app"
   ```
   Below, `plainsight` is the command that `plainsight install` adds. On a machine where plainsight is not installed yet, use `node ~/.plainsight/app/bin/plainsight.js` (macOS/Linux) or `node "$env:USERPROFILE\.plainsight\app\bin\plainsight.js"` (Windows PowerShell) instead, and on Windows give file paths the same way, e.g. `--token-file "$env:USERPROFILE\.plainsight\ts-api-token"`.
3. **Dry run:**
   ```sh
   plainsight pool bootstrap --token-file ~/.plainsight/ts-api-token
   ```
   - Backs up your current policy to `~/.plainsight/policy-backup-<time>.json`.
   - Writes the proposed policy to `~/.plainsight/policy-proposed.json` and has Tailscale validate it.
   - If the policy has old-style `acls` rules (anything other than allow-all), bootstrap stops here and **changes nothing**: it only writes `grants` and will not drop or rewrite your `acls`. Merge by hand ([Manual](#manual-admin-console)), or convert your `acls` to grants first.
4. **Apply:** re-run with `--apply`. This saves the policy with an ETag check, so it never overwrites a concurrent edit.
   - If your policy is not Tailscale's untouched default (including a policy an earlier plainsight bootstrap wrote), bootstrap refuses to apply. Review the proposed file, then re-run with `--apply --force`, or merge by hand using [the policy below](#the-policy).
   - Re-running is safe: it never adds a grant or test twice.
   - After applying, bootstrap deletes the old `svc:plainsight` Tailscale Service if it exists (left by plainsight 0.1).
5. **Mint the join key:**
   ```sh
   plainsight pool key --token-file ~/.plainsight/ts-api-token
   ```
   Saves a reusable, pre-approved `tag:plainsight` key to `~/.plainsight/tailscale-authkey.txt` (mode 600). It is never printed. `--out FILE` picks another file; `--days N` sets the expiry (default 90, Tailscale's maximum). Hand the key to new boxes privately. A box needs it only once, at `tailscale up`.
   - The key is **not ephemeral** by default: Tailscale deletes ephemeral devices soon after they go offline, so a box that is off for a weekend would have to rejoin. Add `--ephemeral` only for throwaway CI runners or containers.
6. **Revoke the API token** (Settings → Keys). You only need a new one to mint the next key or change the policy again.

### What bootstrap changes in your policy

| Part | What bootstrap does |
|---|---|
| `tagOwners` | Adds `tag:plainsight: ["autogroup:admin"]`. Removes `tag:plainsight-viewer` (0.1). Keeps your other tags |
| `hosts` | Unchanged |
| `acls` | An allow-all rule is removed. Any other `acls` rule: bootstrap refuses and changes nothing (merge by hand) |
| `grants` | Removes the allow-all grant and every grant that mentions `plainsight` (e.g. an older `plainsight-admin` grant), then adds the three grants below. Keeps your other grants. Never duplicates |
| `autoApprovers` | Removes the `svc:plainsight` entry (0.1). Keeps everything else |
| `tests` | Keeps every existing test except ones about `svc:plainsight` or `tag:plainsight-viewer`, and drops duplicates. Adds plainsight's box test if no test for `tag:plainsight` exists |
| everything else (`ssh`, `nodeAttrs`, `groups`, …) | Unchanged |

## Manual (admin console)

1. **Access controls** → JSON editor: back up the current file, then merge in [the policy](#the-policy). Save. Tailscale runs the policy's `tests` and refuses to save if they fail.
2. **Settings → Keys → Generate auth key**: Reusable ✓, Ephemeral ✗ (✓ only for throwaway CI/containers), Pre-approved ✓, Tags: `tag:plainsight`, expiry up to 90 days.

MagicDNS and HTTPS certificates are not needed. Sync uses tailnet IPs directly.

---

## The policy

[policy/policy.example.hujson](../policy/policy.example.hujson) has a commented copy. The essential parts:

```jsonc
{
  "tagOwners": { "tag:plainsight": ["autogroup:admin"] },
  "grants": [
    // your devices reach each other and the internet (exit nodes)
    {"src": ["autogroup:member"], "dst": ["autogroup:member", "autogroup:internet"], "ip": ["*"]},
    // boxes reach only each other, only on the sync port
    {"src": ["tag:plainsight"], "dst": ["tag:plainsight"], "ip": ["tcp:4747"]},
    // your devices connect out to boxes on the sync port (that is how they share); boxes can only reply
    {"src": ["autogroup:member"], "dst": ["tag:plainsight"], "ip": ["tcp:4747"]}
  ],
  "tests": [
    {"src": "tag:plainsight", "accept": ["tag:plainsight:4747"], "deny": ["tag:plainsight:22"]},
    // optional: one of your own devices, by its Tailscale IP
    {"src": "100.x.y.z", "accept": ["tag:plainsight:4747"], "deny": ["tag:plainsight:22"]}
  ]
}
```

### What the policy does

| From | To | Allowed |
|---|---|---|
| Box (`tag:plainsight`) | Other boxes | tcp:4747 only (sync) |
| Box | Your devices, the internet via your exit nodes | Nothing. Boxes can only reply to connections your devices open |
| Your devices (`autogroup:member`) | Each other, the internet via exit nodes | Everything |
| Your devices | Boxes | tcp:4747 only (they sync by connecting out) |

`autogroup:member` covers every untagged device logged in as a member of your tailnet, so any number of personal machines can share without a policy change per device. They exchange data only through boxes; they never connect to each other for plainsight.

The `tests` block makes Tailscale reject any later policy edit that breaks the isolation. Add your own, e.g. `{"src": "tag:plainsight", "deny": ["<your-phone-ip>:443"]}`; bootstrap keeps them.

### Personal devices

Your own computers stay untagged (normal devices logged in as you). They still share their usage: a personal machine never accepts sync connections; it **connects out** to every online box, pushes its new events and pulls everything it is missing in the same exchange. The third grant above allows exactly that. With no box online, a personal machine has only its own usage plus what it got at its last sync.

Your phone needs nothing here. It opens the dashboard at `https://<hostname>` through Cloudflare, with or without Tailscale.

---

## Upgrading from an earlier plainsight policy

Earlier versions let one personal computer reach boxes through a `plainsight-admin` host and grant (`--admin-ip`). That is no longer needed: every member device may now reach boxes on tcp:4747.

- Re-run `plainsight pool bootstrap --token-file F` (dry run), then `--apply --force`. It replaces the old `plainsight-admin` grant with the `autogroup:member → tag:plainsight` grant and keeps your ssh, nodeAttrs, hosts, other grants and tests.
- The `plainsight-admin` entry in `hosts` is removed once no grant, test or ssh rule refers to it.
- A test that expects `tag:plainsight:22` to be accepted from a non-box source is adjusted automatically (no grant opens ssh on boxes any more).

## Upgrading from plainsight 0.1

plainsight 0.1 also published the dashboard inside the tailnet: a Tailscale Service `svc:plainsight` on boxes, `https://<computer>.<tailnet>.ts.net:4748` and raw `tcp:80` on your computer, a custom-domain follower (`plainsight dns`) and view-only devices (`tag:plainsight-viewer`). All of that is gone.

1. **Update every machine:** `node ~/.plainsight/app/bin/plainsight.js update` (Windows: `node "$env:USERPROFILE\.plainsight\app\bin\plainsight.js" update`), then the same with `install` once. Older versions' `update` only pulled and restarted; `install` adds the `plainsight` command and the current hook. On start, the daemon removes the `tailscale serve` entries that point at its own ports (4748, 4749) and its `svc:plainsight` serve config. Entries for anything else are left alone.
   - Linux without Tailscale operator rights: the removal fails and `daemon.log` shows `could not remove tailscale serve ...`. Run the command it names with `sudo` once.
2. **Rewrite the policy:** `plainsight pool bootstrap --token-file F` (dry run), then add `--apply --force`. The old policy is not the default, so `--force` is needed. This removes the service grants, the viewer tag and its grants, the service auto-approver and their tests, and deletes `svc:plainsight`.
3. **Remove view-only devices:** admin console → Machines → the device → *Remove*. Phones now use the Cloudflare URL and need no Tailscale.
4. **Custom domain:** if you used one with `plainsight dns`, give the same hostname to `plainsight cloudflare setup --hostname`. It replaces the old A record with the tunnel record ([DASHBOARD.md](DASHBOARD.md)).
5. Old config keys (`hostService`, `serveTailnet`, `tailnetPort`, `tailnetHttpPort`, `dns`) are ignored. You can delete them from `config.json`.
6. Set up the dashboard: [DASHBOARD.md](DASHBOARD.md).

---

## Plan limits and housekeeping

- **Tagged devices:** every box is one. The free Personal plan was reported in 2026 to allow 50 tagged devices; see [tailscale.com/pricing](https://tailscale.com/pricing).
- **Offline boxes stay:** boxes joined with the default (non-ephemeral) key stay in the tailnet while off. Remove retired ones by hand (below). Boxes joined with an `--ephemeral` key are removed by Tailscale soon after they go offline. Either way, their usage history survives on the other machines.
- **Auth key expiry:** 90 days at most. Mint a new one with `pool key`; already-joined boxes are unaffected.
- **Remove a box now:** admin console → Machines → *Remove*, or `tailscale logout` on the box. Also run `plainsight tunnel leave` (or `plainsight uninstall`) on it, or it keeps serving the dashboard over the internet ([DASHBOARD.md](DASHBOARD.md#removing-a-machine)).
- **Rotate the join key:** revoke it (Settings → Keys). Existing boxes keep working, and no new box can join until you mint another.
