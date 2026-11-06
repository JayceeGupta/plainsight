---
name: plainsight-setup
description: Set up plainsight on this machine. plainsight shares Claude Code and Codex usage numbers (tokens, cost, sessions; never content) peer to peer across machines over Tailscale, with a dashboard served through a Cloudflare Tunnel behind a login, and MCP. Use when asked to install, join, set up, repair or uninstall plainsight, to add a machine to the dashboard tunnel, or to start a new plainsight pool and its dashboard.
---

# plainsight setup

You are setting up plainsight on the machine you are running on. Work through the steps in order. Run commands yourself; ask the human only for decisions and for anything that needs their login or secrets.

Repository: https://github.com/JayceeGupta/plainsight
Install location: `~/.plainsight/app` (Windows: `%USERPROFILE%\.plainsight\app`). Data: `~/.plainsight/`.

How it fits together: Tailscale carries usage sync between machines (boxes are tagged `tag:plainsight` and reach each other only on tcp:4747). The dashboard is `https://<hostname>` behind Cloudflare Access, served through a Cloudflare Tunnel by every machine that holds the tunnel token.

## Ground rules

- **Never print, echo, log or commit secrets.** That covers Tailscale auth keys (`tskey-auth-…`), Tailscale API tokens (`tskey-api-…`), the Cloudflare tunnel token, Cloudflare API tokens, Google OAuth client secrets, and account emails beyond showing them once to the human for a choice. Read secrets from a file or environment variable inside the command (`--auth-key="$(cat FILE)"`, `--token-file FILE`) and delete temporary files after use. Never put a secret directly on a command line.
- Ask before installing system software (Node, git, Tailscale) and say which command you will run. plainsight downloads `cloudflared` by itself when a machine joins the tunnel; mention that to the human.
- Don't change Tailscale policy unless the human says this machine is starting a new pool (Path A).
- Don't run `plainsight cloudflare setup` or `teardown` unless the human is the owner and asks for the dashboard to be set up or removed. Setup replaces DNS records on the hostname; confirm the hostname first.
- If a step fails, read `~/.plainsight/daemon.log`, `~/.plainsight/cloudflared.log` and `plainsight doctor` output before trying something else.
- Finish with a short report (step 10).

## Step 0: Pick the path

Ask the human which applies. Recommend one if it is obvious.

| Path | When | Tailscale identity | Dashboard tunnel |
|---|---|---|---|
| **A: Start a pool** | First machine; the human owns or admins the tailnet and nobody has set plainsight up there yet | Do Path A once, then continue as C (usually the owner's own computer) or B | The owner runs `cloudflare setup` (step 8A) |
| **B: Join as a box** | A shared or ephemeral machine that should share its usage and help serve the dashboard | Tagged `tag:plainsight` via auth key; isolated from the owner's other devices | `tunnel join` with the token from the owner (step 8B) |
| **C: Personal device** | The owner's own laptop or desktop that already uses Tailscale normally and should share its usage | Stays untagged (normal user device); it dials out to boxes and needs one policy line (docs/TAILNET.md, "Admin device") | Has the token already if it ran `cloudflare setup`; otherwise optional step 8B |

If the human says "join the pool" or gives you an auth key or tunnel token, it is Path B.

## Step 1: Prerequisites

Check what exists:

```sh
node --version      # need >= 18.17 (20+ recommended)
git --version
tailscale version   # any recent version
```

Install what is missing (ask first):

- **Node:** Linux: your package manager or `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`. macOS: `brew install node`. Windows: `winget install OpenJS.NodeJS.LTS`.
- **git:** Linux: `sudo apt-get install -y git`. macOS: `xcode-select --install`. Windows: `winget install Git.Git`.
- **Tailscale:** Linux: `curl -fsSL https://tailscale.com/install.sh | sh`. macOS: `brew install --cask tailscale`, then open it once; or headless `brew install tailscale && sudo brew services start tailscale`. Windows: `winget install Tailscale.Tailscale`.
- **Containers without `/dev/net/tun`:** run `tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:1055 --state=mem: &`, and set `PLAINSIGHT_SOCKS=127.0.0.1:1055` for the plainsight daemon (step 7).
- **cloudflared** (optional): the daemon uses it from `PATH` if installed, otherwise downloads it from Cloudflare's GitHub releases into `~/.plainsight/bin`. Install it yourself only if the machine cannot reach GitHub.

## Step 2: Path A only, prepare the tailnet (once per pool)

Needs a Tailscale **API access token** from the tailnet owner or admin: Admin console > Settings > Keys > *Generate access token*, short expiry (e.g. 7 days). Ask the human to save it to a file only they and you can read, e.g. `~/.plainsight/ts-api-token`. Do not ask them to paste it in chat if a private method exists.

Clone the repo first (step 4), then:

```sh
node ~/.plainsight/app/bin/plainsight.js pool bootstrap --token-file ~/.plainsight/ts-api-token --admin-ip <TAILSCALE_IP_OF_OWNER_PC>
```

- `--admin-ip` (optional): the owner's own computer, which may then reach boxes and sync by dialing out (Path C devices). Find it with `tailscale ip -4` on that computer.
- This is a **dry run**. It backs up the current policy, writes `~/.plainsight/policy-proposed.json` and validates it with Tailscale. Show the human what will change (docs/TAILNET.md, "What the policy does" and "What bootstrap changes"). Then, with their OK:

```sh
node ~/.plainsight/app/bin/plainsight.js pool bootstrap --token-file ~/.plainsight/ts-api-token --admin-ip <IP> --apply
node ~/.plainsight/app/bin/plainsight.js pool key --token-file ~/.plainsight/ts-api-token
```

- If the policy is not Tailscale's default (custom rules, or a policy from an earlier plainsight), bootstrap refuses to apply. Show the human the proposed file and docs/TAILNET.md; apply with `--apply --force` only if they approve. It also removes plainsight 0.1's `svc:plainsight` service and viewer rules.
- `pool key` saves a reusable, ephemeral, pre-approved `tag:plainsight` auth key to `~/.plainsight/tailscale-authkey.txt` without printing it. The human hands that key to new boxes privately.
- Remind the human to revoke the API token afterwards (Settings > Keys).

## Step 3: Join Tailscale

**Path B (box):** you need the pool's auth key. Ask the human to put it in a file (e.g. `/tmp/ps-key`, mode 600) or an environment variable. Pick a short nickname with the human (e.g. `gpu-1`, `ci-runner`, `jayam-laptop`); it is how everyone will recognise this machine.

```sh
# Linux
sudo tailscale up --auth-key="$(cat /tmp/ps-key)" --advertise-tags=tag:plainsight --hostname=ps-<nick>
# macOS / Windows (admin shell on Windows)
tailscale up --auth-key="$(cat /tmp/ps-key)" --advertise-tags=tag:plainsight --hostname=ps-<nick>
rm -f /tmp/ps-key
```

If the machine is already logged into a tailnet with a different identity, add `--force-reauth`. Ask first: it disconnects that identity.

No auth key? `sudo tailscale up --advertise-tags=tag:plainsight` prints a login URL. The human (a tailnet admin) opens it. The device still becomes tagged.

**Path C (personal device):** it should already be on the tailnet as the owner's device. Check that `tailscale status` shows the boxes. Its Tailscale IP must be in the policy's `plainsight-admin` host (docs/TAILNET.md); otherwise it cannot reach boxes.

Verify with `tailscale status --self --json`. For Path B, `Self.Tags` must contain `tag:plainsight`.

## Step 4: Get the code

```sh
git clone https://github.com/JayceeGupta/plainsight ~/.plainsight/app
# Windows PowerShell: git clone https://github.com/JayceeGupta/plainsight "$env:USERPROFILE\.plainsight\app"
```

Below, `plainsight` means `node ~/.plainsight/app/bin/plainsight.js`. Optionally add an alias.

## Step 5: Choose what to track (ask the human)

```sh
plainsight discover
```

This lists every Claude Code install (`~/.claude`, `~/.claude-*`, `$CLAUDE_CONFIG_DIR`) and Codex install (`~/.codex`, `$CODEX_HOME`), with the logged-in account, a **subscription id**, the subscription start date and how much history exists.

Show this to the human and ask, for each install:

1. **Track it?** Track only installs logged into a subscription they want shared.
2. **Label:** a human name for the subscription, e.g. `Max (Jayam)`, `Team Codex`. The subscription id is derived from the account, so every machine on the same account lands in the same subscription automatically. Use the same label on every machine; the latest label wins pool-wide.
3. **Since** (Claude only, optional): Claude Code logs do not say which account wrote each message. If this install was used with a different account before, set *since* to when the current account started. Suggest the "subscription started" date shown. Codex records the account per session, so it needs no *since*.

Also ask for the machine's **nickname** (if not chosen in step 3) and the **operator** (who uses this machine).

Different subscriptions are never mixed, including two subscriptions of the same provider. Usage from an install logged into an untracked account is ignored.

## Step 6: Initialise

```sh
plainsight init --nick "<nick>" --operator "<who uses this machine>" \
  --track "claude|/home/me/.claude|Max (Jayam)|2026-03-29" \
  --track "codex|/home/me/.codex|Team Codex"
```

- Format: `PROVIDER|DIR|LABEL|SINCE`, with `|` as separator (Windows paths contain `:`). Use the exact DIR printed by discover.
- Re-running `init` replaces the config but keeps the machine's identity and its dashboard settings (`cloudflare`, tunnel token path).

## Step 7: Install and start

```sh
plainsight install
```

This:
- adds a Claude Code `SessionStart` hook that keeps the daemon alive
- sets `cleanupPeriodDays: 3650` so Claude Code stops deleting transcripts after 30 days
- registers the `plainsight` MCP server for Claude Code (`claude mcp add --scope user`) and Codex (`config.toml`)
- copies the `plainsight` skill
- installs a background service (systemd user unit, launchd agent or Windows Startup-folder launcher, no admin needed)
- starts the daemon

The first start backfills all existing history (seconds to a few minutes).

- No systemd, e.g. in a container: the SessionStart hook starts the daemon. For Codex-only containers add `plainsight ensure` to the shell profile.
- Userspace networking: set `PLAINSIGHT_SOCKS=127.0.0.1:1055` in the service environment (systemd: `systemctl --user edit plainsight` → `[Service]` `Environment=PLAINSIGHT_SOCKS=127.0.0.1:1055`).

## Step 8: Dashboard tunnel

### 8A: Owner, set up the dashboard (once; Path A or C on the owner's computer)

Only when the human is the owner and wants the shared dashboard. Full guide: docs/DASHBOARD.md. Ask the human for:

1. **Hostname**, e.g. `usage.example.com`, in a domain whose DNS is on Cloudflare. One level below the domain. Warn that setup replaces any `A`/`AAAA`/`CNAME` record on that exact name.
2. **Zero Trust enabled**: they open https://one.dash.cloudflare.com once, pick a team name and the Free plan (it may ask for a card; nothing is charged on Free). You cannot do this for them.
3. **Who may sign in**: email addresses and/or whole email domains. Without any, setup allows the Cloudflare account's own email.
4. **A Cloudflare API token** in a private file, e.g. `~/.plainsight/cf-token`. They create it at dash.cloudflare.com → My Profile → API Tokens → *Create Custom Token* with: Account › Cloudflare Tunnel › Edit; Account › Access: Apps and Policies › Edit; Account › Access: Organizations, Identity Providers, and Groups › Edit; Account › Workers Scripts › Edit; Zone › Workers Routes › Edit; Zone › DNS › Edit; optional User › User Details › Read. Account Resources: their account. Zone Resources: the domain. Short TTL.

Then:

```sh
plainsight cloudflare setup --hostname <hostname> --email <a@x.com,b@y.com> [--domain <example.com>] --token-file ~/.plainsight/cf-token
plainsight cloudflare status --token-file ~/.plainsight/cf-token
```

- Setup creates the tunnel, saves the tunnel token to `~/.plainsight/tunnel-token` (never printed), creates the Access app and policy, the "No machine is online" Worker and the DNS record, and restarts the daemon. It is safe to re-run: options left out keep their current values (allowed list, sign-in options, session length).
- If the token sees several accounts, it asks for `--account ID`.
- `status` should show `machines connected: 1` within a minute or two (after the first sync).

**Optional, Google sign-in.** Walk the human through docs/DASHBOARD.md "Google sign-in" (Google Cloud Console: project → Branding → Audience External + Testing + add themselves as test user → Web client with JavaScript origin `https://<team>.cloudflareaccess.com` and redirect URI `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`). They save the client secret to a file; then:

```sh
plainsight access google --client-id <ID> --client-secret-file <FILE> --token-file ~/.plainsight/cf-token
rm <FILE>
```

**Tokens for boxes.** For each box that should serve the dashboard:

```sh
plainsight cloudflare tunnel-token --out <FILE> --token-file ~/.plainsight/cf-token
```

The human hands that file to the box privately, then deletes it. Remind them to revoke the Cloudflare API token when done.

### 8B: Box, join the tunnel (Path B, or a Path C device that did not run setup)

Ask the human for the tunnel token file the owner gave them privately (e.g. `/tmp/ps-tunnel-token`, mode 600). If they have none, skip this step: the machine still shares usage, it just does not serve the dashboard.

```sh
plainsight tunnel join --token-file /tmp/ps-tunnel-token
rm -f /tmp/ps-tunnel-token
```

The token is stored at `~/.plainsight/tunnel-token` (mode 600). The daemon restarts, downloads `cloudflared` if needed, and joins the tunnel after its first successful sync.

## Step 9: Verify

```sh
plainsight doctor
plainsight status
plainsight url
```

Expect:
- node OK
- each tracked install logged into its tracked account
- tailscale Running; Path B shows tagged
- daemon running
- sync OK with each online peer
- with a tunnel token: `dashboard tunnel connector running`. `waiting for the first sync` means sync has not succeeded yet; fix sync first

The dashboard is at `http://127.0.0.1:4748` locally and at `https://<hostname>` for everyone allowed to sign in (no Tailscale needed on their devices). On a box, `plainsight url` does not know the hostname; the owner's machine prints it.

## Step 10: Report to the human

Tell them, in a few lines:
- the machine's nickname
- what is tracked: label, provider, since
- whether it joined as tagged or untagged
- which peers it synced with
- whether it is in the dashboard tunnel, and the dashboard URLs
- anything that failed and the exact fix

Mention that Claude Code / Codex sessions must be restarted to pick up the MCP server and skill. If secret files were used, confirm they were deleted, and remind the owner to revoke API tokens they no longer need.

## Repair, update, uninstall

- Update: `plainsight update` (git pull + restart). Upgrading from 0.1: see docs/TAILNET.md "Upgrading from plainsight 0.1".
- Daemon not running: `plainsight ensure`, then read `~/.plainsight/daemon.log`.
- Tunnel connector not running: `plainsight tunnel status`, `~/.plainsight/cloudflared.log`, then `plainsight restart`.
- Track something else: re-run `plainsight init ...`, then `plainsight restart`.
- Stop serving the dashboard from this machine: `plainsight tunnel leave`.
- Uninstall: `plainsight tunnel leave`, then `plainsight uninstall` (add `--purge` to delete local data, including the tunnel token). Then remove the hook and MCP entries it lists. Box: `sudo tailscale logout` (ephemeral nodes also disappear on their own after going offline).

More detail: `~/.plainsight/app/README.md`, `docs/TAILNET.md`, `docs/DASHBOARD.md`, `docs/JOIN.md`, `docs/TROUBLESHOOTING.md`.
