---
name: plainsight-setup
description: Set up plainsight on this machine. plainsight shares Claude Code and Codex usage numbers (tokens, cost, sessions; never content) peer to peer across machines over Tailscale, with a dashboard served through a Cloudflare Tunnel behind a login, and MCP. Use when asked to install, join, set up, repair or uninstall plainsight, to add a machine to the dashboard tunnel, or to start a new plainsight pool and its dashboard.
---

# plainsight setup

You are setting up plainsight on the machine you are running on. Work through the steps in order. Run commands yourself; ask the human only for decisions and for anything that needs their login or secrets.

Repository: https://github.com/JayceeGupta/plainsight
Install location: `~/.plainsight/app` (Windows: `%USERPROFILE%\.plainsight\app`). Data: `~/.plainsight/` (Windows: `%USERPROFILE%\.plainsight\`).

How it fits together: Tailscale carries usage sync between machines. Boxes are tagged `tag:plainsight`; only boxes accept sync, and they reach each other only on tcp:4747. Personal (untagged) machines connect out to boxes and never to each other, so **a pool needs at least one box** or nothing is shared. The dashboard is `https://<hostname>` behind Cloudflare Access, served through a Cloudflare Tunnel by every machine that holds the tunnel token.

On Windows, use PowerShell. It does not expand `~` for programs like node or tailscale, so use `$env:USERPROFILE\...` wherever a path below starts with `~/`.

## Ground rules

- **Never print, echo, log or commit secrets.** That covers Tailscale auth keys (`tskey-auth-…`), Tailscale API tokens (`tskey-api-…`), the Cloudflare tunnel token, Cloudflare API tokens, Google OAuth client secrets, and account emails beyond showing them once to the human for a choice. Pass secrets as files (`--auth-key=file:FILE`, `--token-file FILE`, `--client-secret-file FILE`) or environment variables, and delete temporary files after use. Never put a secret directly on a command line.
- Ask before installing system software (Node, git, Tailscale) and say which command you will run. plainsight downloads `cloudflared` by itself when a machine joins the tunnel (verified against the SHA-256 in the GitHub release notes); mention that to the human.
- Ask the human which Claude/Codex installs to track, what to call each subscription, and the machine's nickname. Don't guess.
- Don't change Tailscale policy unless the human says this machine is starting a new pool (Path A).
- Don't run `plainsight cloudflare setup` or `teardown` unless the human is the owner and asks for the dashboard to be set up or removed. Setup replaces DNS records on the hostname; confirm the hostname first.
- If a step fails, read `~/.plainsight/daemon.log`, `~/.plainsight/cloudflared.log` and `plainsight doctor` output before trying something else.
- Finish with a short report (step 10).

## Step 0: Pick the path

Ask the human which applies. Recommend one if it is obvious.

| Path | When | Tailscale identity | Dashboard tunnel |
|---|---|---|---|
| **A: Start a pool** | First machine; the human owns or admins the tailnet and nobody has set plainsight up there yet | Do Path A once, then continue as C (usually the owner's own computer) or B | The owner runs `cloudflare setup` (step 8A) |
| **B: Join as a box** | A machine that should accept sync and help serve the dashboard: a server, shared workstation, CI runner. Every pool needs at least one; an always-on machine is best | Tagged `tag:plainsight` via auth key; isolated from the owner's other devices | `tunnel join` with the token from the owner (step 8B) |
| **C: Personal device** | The owner's or a team member's own laptop or desktop that uses Tailscale normally and should share its usage | Stays untagged (normal user device); it connects out to boxes. No policy change per device | Has the token already if it ran `cloudflare setup`; otherwise optional step 8B |

If the human says "join the pool" or gives you an auth key or tunnel token, it is Path B. If the pool has no box yet, tell the human that nothing is shared until one joins.

## Step 1: Prerequisites

Check what exists:

```sh
node --version      # need >= 20
git --version
tailscale version   # any recent version
```

Install what is missing (ask first):

- **Node 20+:** Linux: your package manager or `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`. macOS: `brew install node`. Windows: `winget install OpenJS.NodeJS.LTS`.
- **git:** Linux: `sudo apt-get install -y git`. macOS: `xcode-select --install`. Windows: `winget install Git.Git`.
- **Tailscale:** Linux: `curl -fsSL https://tailscale.com/install.sh | sh`. macOS: `brew install --cask tailscale`, then open it once; or headless `brew install tailscale && sudo brew services start tailscale`. Windows: `winget install Tailscale.Tailscale`.
- **Containers without `/dev/net/tun`:** run `tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:1055 --state=mem: &`, and set `PLAINSIGHT_SOCKS=127.0.0.1:1055` for the plainsight daemon (step 7).
- **cloudflared** (optional): the daemon uses it from `PATH` if installed, otherwise downloads it from Cloudflare's GitHub releases into `~/.plainsight/bin` and checks its SHA-256. Install it yourself only if the machine cannot reach GitHub or the download is refused.

After installing on Windows, open a new terminal so `node`, `git` and `tailscale` are on PATH.

## Step 2: Get the code

```sh
# macOS / Linux
git clone https://github.com/JayceeGupta/plainsight ~/.plainsight/app
```

```powershell
# Windows PowerShell
git clone https://github.com/JayceeGupta/plainsight "$env:USERPROFILE\.plainsight\app"
```

Until step 7 installs the `plainsight` command, run plainsight through node. Below, **`PS`** stands for:

| OS | `PS` |
|---|---|
| macOS / Linux | `node ~/.plainsight/app/bin/plainsight.js` |
| Windows PowerShell | `node "$env:USERPROFILE\.plainsight\app\bin\plainsight.js"` (or set `$ps = "$env:USERPROFILE\.plainsight\app\bin\plainsight.js"` and run `node $ps …`) |

If plainsight is already installed on this machine (repair, update), skip to the step you need and use `plainsight` directly.

## Step 3: Path A only, prepare the tailnet (once per pool)

Needs a Tailscale **API access token** from the tailnet owner or admin: Admin console > Settings > Keys > *Generate access token*, short expiry (e.g. 7 days). Ask the human to save it to a file only they and you can read: `~/.plainsight/ts-api-token` (macOS/Linux: then `chmod 600 ~/.plainsight/ts-api-token`; Windows: `$env:USERPROFILE\.plainsight\ts-api-token`, which is private to their user). Do not ask them to paste it in chat if a private method exists.

Dry run:

```sh
PS pool bootstrap --token-file ~/.plainsight/ts-api-token
```

- It backs up the current policy, writes `~/.plainsight/policy-proposed.json` and validates it with Tailscale. Show the human what will change (docs/TAILNET.md, "What the policy does" and "What bootstrap changes"): boxes reach each other on tcp:4747; every member device may connect out to boxes on tcp:4747; boxes cannot open connections to anything else.
- If the policy uses old-style `acls` rules, bootstrap refuses and changes nothing. Tell the human; they merge by hand (docs/TAILNET.md, "Manual") or convert their acls to grants first. Do not try to work around it.

Then, with their OK:

```sh
PS pool bootstrap --token-file ~/.plainsight/ts-api-token --apply
PS pool key --token-file ~/.plainsight/ts-api-token
```

- If the policy is not Tailscale's default (custom rules, or a policy from an earlier plainsight), bootstrap refuses to apply. Show the human the proposed file and docs/TAILNET.md; apply with `--apply --force` only if they approve. It keeps their ssh, nodeAttrs, hosts, other grants and tests, adds nothing twice, replaces an older `plainsight-admin` grant, and removes plainsight 0.1's `svc:plainsight` service and viewer rules.
- `pool key` saves a reusable, pre-approved, non-ephemeral `tag:plainsight` auth key to `~/.plainsight/tailscale-authkey.txt` without printing it. The human hands that key to new boxes privately. Use `--ephemeral` only for throwaway CI runners or containers: Tailscale deletes ephemeral devices soon after they go offline.
- Remind the human to revoke the API token afterwards (Settings > Keys).

## Step 4: Join Tailscale

**Path B (box):** you need the pool's auth key. Ask the human to put it in a private file: macOS/Linux `/tmp/ps-key` (then `chmod 600 /tmp/ps-key`), Windows `$env:TEMP\ps-key`. Pick a short nickname with the human (e.g. `gpu-1`, `ci-runner`, `build-server`); it is how everyone will recognise this machine. `--auth-key=file:` makes Tailscale read the key from the file, so it never appears in the command line.

```sh
# Linux
sudo tailscale up --auth-key=file:/tmp/ps-key --advertise-tags=tag:plainsight --hostname=ps-<nick>
# macOS
tailscale up --auth-key=file:/tmp/ps-key --advertise-tags=tag:plainsight --hostname=ps-<nick>
rm -f /tmp/ps-key
```

```powershell
# Windows (elevated terminal if it says access is denied)
tailscale up "--auth-key=file:$env:TEMP\ps-key" --advertise-tags=tag:plainsight --hostname=ps-<nick>
Remove-Item -Force "$env:TEMP\ps-key"
```

The box needs the key only for this command. If the machine is already logged into a tailnet with a different identity, add `--force-reauth`. Ask first: it disconnects that identity.

No auth key? `tailscale up --advertise-tags=tag:plainsight` (with `sudo` on Linux) prints a login URL. The human (a tailnet admin) opens it. The device still becomes tagged.

**Path C (personal device):** it should already be on the tailnet as the human's device. No tagging and no policy change: the pool policy lets every member device reach boxes on tcp:4747. Check that `tailscale status` shows at least one box.

Verify with `tailscale status --self --json`. For Path B, `Self.Tags` must contain `tag:plainsight`.

## Step 5: Choose what to track (ask the human)

```sh
PS discover
```

This lists every Claude Code install (`~/.claude`, `~/.claude-*`, `$CLAUDE_CONFIG_DIR`) and Codex install (`~/.codex`, `$CODEX_HOME`), with the logged-in account, a **subscription id**, the subscription start date and how much history exists.

Show this to the human and ask, for each install:

1. **Track it?** Track only installs logged into a subscription they want shared.
2. **Label:** a human name for the subscription, e.g. `Max (team)`, `Team Codex`. The subscription id is derived from the account, so every machine on the same account lands in the same subscription automatically. Use the same label on every machine; the latest label wins pool-wide.
3. **Since** (Claude only, optional): Claude Code logs do not say which account wrote each message. If this install was used with a different account before, set *since* to when the current account started. Suggest the "subscription started" date shown. Codex records the account per session, so it needs no *since*.

Also ask for the machine's **nickname** (if not chosen in step 4) and the **operator** (who uses this machine).

Different subscriptions are never mixed, including two subscriptions of the same provider. Usage from an install logged into an untracked account is ignored.

## Step 6: Initialise

```sh
# macOS / Linux
PS init --nick "<nick>" --operator "<who uses this machine>" \
  --track "claude|/home/me/.claude|Max (team)|2026-03-29" \
  --track "codex|/home/me/.codex|Team Codex"
```

```powershell
# Windows PowerShell (backtick continues the line)
node $ps init --nick "<nick>" --operator "<who uses this machine>" `
  --track "claude|C:\Users\me\.claude|Max (team)|2026-03-29" `
  --track "codex|C:\Users\me\.codex|Team Codex"
```

- Format: `PROVIDER|DIR|LABEL|SINCE`, with `|` as separator (Windows paths contain `:`). Use the exact DIR printed by discover.
- Ports: defaults are sync 4747 and local dashboard 4748 (read-only view 4749). Change only if needed: `--web-port N` if 4748 is taken (the view moves to N + 1). Keep the sync port at 4747 (`--port`): the tailnet policy allows only tcp:4747.
- Re-running `init` replaces the config but keeps the machine's identity, ports and dashboard settings (`cloudflare`, tunnel token path).

## Step 7: Install and start

```sh
PS install
```

This:
- adds a Claude Code `SessionStart` hook (`plainsight ensure --quiet`) that keeps the daemon alive; older plainsight hooks are replaced
- sets `cleanupPeriodDays: 3650` so Claude Code stops deleting transcripts after 30 days
- registers the `plainsight` MCP server for Claude Code (`claude mcp add --scope user`) and Codex (`config.toml`)
- copies the `plainsight` skill
- installs the `plainsight` command: macOS/Linux a symlink `~/.local/bin/plainsight` (it prints a hint if `~/.local/bin` is not on PATH; add `export PATH="$HOME/.local/bin:$PATH"` to the shell profile); Windows `%USERPROFILE%\.plainsight\bin\plainsight.cmd`, added to the user PATH
- installs a background service (systemd user unit, launchd agent or Windows Startup-folder launcher, no admin needed)
- starts the daemon

From here on use `plainsight …`. On Windows that needs a **new terminal**; in the current one keep using `PS`.

The first start backfills all existing history (seconds to a few minutes).

- Linux: if install warns that it could not enable lingering, the daemon stops at logout. Ask the human to run `sudo loginctl enable-linger $USER`.
- No systemd, e.g. in a container: the SessionStart hook starts the daemon. For Codex-only containers add `plainsight ensure --quiet` to the shell profile.
- Userspace networking: set `PLAINSIGHT_SOCKS=127.0.0.1:1055` in the service environment (systemd: `systemctl --user edit plainsight` → `[Service]` `Environment=PLAINSIGHT_SOCKS=127.0.0.1:1055`).

## Step 8: Dashboard tunnel

### 8A: Owner, set up the dashboard (once; Path A or C on the owner's computer)

Only when the human is the owner and wants the shared dashboard. Full guide: docs/DASHBOARD.md. Ask the human for:

1. **Hostname**, e.g. `usage.example.com`, in a domain whose DNS is on Cloudflare. One level below the domain. Warn that setup replaces any `A`/`AAAA`/`CNAME` record on that exact name.
2. **Zero Trust enabled**: they open https://one.dash.cloudflare.com once, pick a team name and the Free plan (it may ask for a card; nothing is charged on Free). You cannot do this for them.
3. **Who may sign in**: email addresses and/or whole email domains they control. Not public providers like gmail.com (`access allow-domain` refuses those unless `--i-understand`). Without any, setup allows the Cloudflare account's own email.
4. **A Cloudflare API token** in a private file, `~/.plainsight/cf-token` (Windows `$env:USERPROFILE\.plainsight\cf-token`). They create it at dash.cloudflare.com → My Profile → API Tokens → *Create Custom Token* with: Account › Cloudflare Tunnel › Edit; Account › Access: Apps and Policies › Edit; Account › Access: Organizations, Identity Providers, and Groups › Edit; Account › Workers Scripts › Edit; Zone › Zone › Read; Zone › Workers Routes › Edit; Zone › DNS › Edit; optional User › User Details › Read. Account Resources: their account. Zone Resources: the domain. Short TTL.

Then:

```sh
plainsight cloudflare setup --hostname <hostname> --email <a@x.com,b@y.com> [--domain <example.com>] --token-file ~/.plainsight/cf-token
plainsight cloudflare status --token-file ~/.plainsight/cf-token
```

- Setup creates the tunnel, saves the tunnel token to `~/.plainsight/tunnel-token` (never printed), creates the Access app and policy, the "No machine is online" Worker and the DNS record, and restarts the daemon. It is safe to re-run: options left out keep their current values (allowed list, sign-in options, session length).
- If the token sees several accounts, it asks for `--account ID`.
- `status` should show `machines connected: 1` within a minute or two (after the first sync).
- Later `access` commands and `cloudflare status` work with a smaller token (docs/DASHBOARD.md, "Cloudflare API token"); `cloudflare tunnel-token` needs the setup token.

**Optional, Google sign-in.** Walk the human through docs/DASHBOARD.md "Google sign-in" (Google Cloud Console: project → Branding → Audience External + Testing + add themselves as test user → Web client with JavaScript origin `https://<team>.cloudflareaccess.com` and redirect URI `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`). They save the client secret to a file; then:

```sh
plainsight access google --client-id <ID> --client-secret-file <FILE> --token-file ~/.plainsight/cf-token
rm <FILE>        # Windows: Remove-Item <FILE>
```

**Tokens for boxes.** For each box that should serve the dashboard:

```sh
plainsight cloudflare tunnel-token --out <FILE> --token-file ~/.plainsight/cf-token
```

The human hands that file to the box privately, then deletes it. Remind them to revoke the Cloudflare API token when done.

### 8B: Box, join the tunnel (Path B, or a Path C device that did not run setup)

Ask the human for the tunnel token file the owner gave them privately: macOS/Linux e.g. `/tmp/ps-tunnel-token` (mode 600), Windows `$env:TEMP\ps-tunnel-token`. If they have none, skip this step: the machine still shares usage, it just does not serve the dashboard.

```sh
plainsight tunnel join --token-file /tmp/ps-tunnel-token
rm -f /tmp/ps-tunnel-token
```

```powershell
plainsight tunnel join --token-file "$env:TEMP\ps-tunnel-token"
Remove-Item -Force "$env:TEMP\ps-tunnel-token"
```

The token is stored at `~/.plainsight/tunnel-token` (mode 600). The daemon restarts, downloads `cloudflared` if needed, and joins the tunnel after its first successful sync.

## Step 9: Verify

```sh
plainsight doctor
plainsight status
plainsight tunnel status
plainsight url
```

Checklist:
- [ ] `doctor`: `OK node` (20 or newer)
- [ ] each tracked install logged into its tracked account
- [ ] tailscale Running; Path B: `this machine is a box (tagged tag:plainsight)`; Path C: `INFO personal machine (untagged)`
- [ ] `boxes online: …` lists at least one box (on a box, the others). `INFO no box online right now` means nothing can sync yet
- [ ] `daemon running`
- [ ] `sync with <box>` OK for each online box
- [ ] with a tunnel token: `dashboard tunnel connector running`, and `tunnel status` shows `"running": true`. `waiting for the first sync` means sync has not succeeded yet; fix sync first. `Tailscale is unavailable` means start or sign in to Tailscale

The dashboard is at `http://127.0.0.1:4748` locally and at `https://<hostname>` for everyone allowed to sign in (no Tailscale needed on their devices). On a box, `plainsight url` does not know the hostname; the owner's machine prints it.

## Step 10: Report to the human

Tell them, in a few lines:
- the machine's nickname
- what is tracked: label, provider, since
- whether it joined as a box (tagged) or personal (untagged)
- which boxes it synced with, or that no box exists yet (nothing is shared until one joins)
- whether it is in the dashboard tunnel, and the dashboard URLs
- anything that failed and the exact fix

Mention that Claude Code / Codex sessions must be restarted to pick up the MCP server and skill, and on Windows that a new terminal is needed for the `plainsight` command. If secret files were used, confirm they were deleted, and remind the owner to revoke API tokens they no longer need.

## Repair, update, uninstall

- Update: `plainsight update` (git pull, then refresh with the new code: re-copies the skill, refreshes the hook, MCP registration and `plainsight` command, restarts the daemon). Coming from a version without the `plainsight` command: `PS update`, then `PS install` once. Upgrading from 0.1: see docs/TAILNET.md "Upgrading from plainsight 0.1".
- Daemon not running: `plainsight ensure`, then read `~/.plainsight/daemon.log`. `port 4748 is used by another program` there: free the port or re-run `init` with `--web-port N`, then `plainsight restart`.
- Stop / restart: `plainsight stop`, `plainsight restart`. With the service installed they go through systemd / launchd, so the daemon really stops and no duplicate starts.
- Tunnel connector not running: `plainsight tunnel status`, `~/.plainsight/cloudflared.log`, then `plainsight restart`.
- Track something else: re-run `plainsight init ...`, then `plainsight restart`.
- Stop serving the dashboard from this machine: `plainsight tunnel leave`.
- Uninstall: `plainsight uninstall` stops the daemon and removes the service, the SessionStart hook, the MCP registration, the skill, the `plainsight` command and the tunnel token; it keeps `~/.plainsight`. `plainsight uninstall --purge` also deletes `~/.plainsight` (code, usage copy, config, auth key, policy backups). On the owner's machine (it has the Cloudflare ids) `--purge` refuses without `--yes`; if the human wants the dashboard gone, run `plainsight cloudflare teardown --yes --token-file …` first. Box: also `tailscale logout` (with `sudo` on Linux).

More detail: `~/.plainsight/app/README.md`, `docs/TAILNET.md`, `docs/DASHBOARD.md`, `docs/JOIN.md`, `docs/TROUBLESHOOTING.md`.
