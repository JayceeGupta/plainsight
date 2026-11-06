---
name: plainsight-setup
description: Set up plainsight on this machine. plainsight shares Claude Code and Codex usage numbers (tokens, cost, sessions; never content) peer to peer across machines over Tailscale, with a dashboard and MCP. Use when asked to install, join, set up, repair or uninstall plainsight, or to start a new plainsight pool for a tailnet.
---

# plainsight setup

You are setting up plainsight on the machine you are running on. Work through the steps in order. Run commands yourself; ask the human only for decisions and for anything that needs their login or secrets.

Repository: https://github.com/JayceeGupta/plainsight
Install location: `~/.plainsight/app` (Windows: `%USERPROFILE%\.plainsight\app`). Data: `~/.plainsight/`.

## Ground rules

- **Never print, echo, log or commit secrets.** That covers Tailscale auth keys (`tskey-auth-…`), API tokens (`tskey-api-…`) and account emails beyond showing them once to the human for a choice. Read secrets from a file or environment variable inside the command (`--auth-key="$(cat FILE)"`) and delete temporary files after use.
- Ask before installing system software (Node, git, Tailscale) and say which command you will run.
- Don't change Tailscale policy unless the human says this machine is starting a new pool (Path A).
- If a step fails, read `~/.plainsight/daemon.log` and `plainsight doctor` output before trying something else.
- Finish with a short report (step 9).

## Step 0: Pick the path

Ask the human which applies. Recommend one if it is obvious.

| Path | When | Tailscale identity |
|---|---|---|
| **A: Start a pool** | First machine; the human owns or admins the tailnet and nobody has set plainsight up there yet | Do Path A once, then continue as B or C on this machine |
| **B: Join as a box** | A shared or ephemeral machine that should share its usage and help host the dashboard | Tagged `tag:plainsight` via auth key; isolated from the owner's other devices |
| **C: Personal device** | The owner's own laptop or desktop that already uses Tailscale normally and should share its usage | Stays untagged (normal user device); it dials out to boxes and needs one policy line (see docs/TAILNET.md, "admin device") |

If the human says "join the pool" or gives you an auth key, it is Path B.

## Step 1: Prerequisites

Check what exists:

```sh
node --version      # need >= 18.17 (20+ recommended)
git --version
tailscale version   # need >= 1.86 for hosting the dashboard service
```

Install what is missing (ask first):

- **Node:** Linux: your package manager or `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`. macOS: `brew install node`. Windows: `winget install OpenJS.NodeJS.LTS`.
- **git:** Linux: `sudo apt-get install -y git`. macOS: `xcode-select --install`. Windows: `winget install Git.Git`.
- **Tailscale:** Linux: `curl -fsSL https://tailscale.com/install.sh | sh`. macOS: `brew install --cask tailscale`, then open it once; or headless `brew install tailscale && sudo brew services start tailscale`. Windows: `winget install Tailscale.Tailscale`.
- **Containers without `/dev/net/tun`:** run `tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:1055 --state=mem: &`, and set `PLAINSIGHT_SOCKS=127.0.0.1:1055` for the plainsight daemon (step 7).

## Step 2: Path A only, prepare the tailnet (once per pool)

Needs a Tailscale **API access token** from the tailnet owner or admin: Admin console > Settings > Keys > *Generate access token*, short expiry (e.g. 7 days). Ask the human to save it to a file only they and you can read, e.g. `~/.plainsight/ts-api-token`. Do not ask them to paste it in chat if a private method exists.

Clone the repo first (step 4), then:

```sh
node ~/.plainsight/app/bin/plainsight.js pool bootstrap --token-file ~/.plainsight/ts-api-token --admin-ip <TAILSCALE_IP_OF_OWNER_PC>
```

- `--admin-ip` (optional): the owner's own computer, which gets full access to boxes (Path C devices). Find it with `tailscale ip -4` on that computer.
- This is a **dry run**. It backs up the current policy, writes `~/.plainsight/policy-proposed.json` and validates it with Tailscale. Show the human what will change (read docs/TAILNET.md, "What the policy does"). Then, with their OK:

```sh
node ~/.plainsight/app/bin/plainsight.js pool bootstrap --token-file ~/.plainsight/ts-api-token --admin-ip <IP> --apply
node ~/.plainsight/app/bin/plainsight.js pool key --token-file ~/.plainsight/ts-api-token
```

- If the policy has custom rules, bootstrap refuses to apply. Show the human the proposed file and docs/TAILNET.md; apply with `--force` only if they approve.
- `pool key` saves a reusable, ephemeral, pre-approved `tag:plainsight` auth key to `~/.plainsight/tailscale-authkey.txt` without printing it. The human hands that key to other boxes privately.
- Optional custom domain: bootstrap prints the service's TailVIP. Add a DNS **A** record `usage.example.com -> <TailVIP>`, DNS-only (not proxied). It only resolves to something reachable inside the tailnet.
- Remind the human to revoke the API token afterwards (Settings > Keys).

## Step 3: Join Tailscale

**Path B (box):** you need the pool's auth key. Ask the human to put it in a file (e.g. `/tmp/ps-key`, mode 600) or an environment variable. Pick a short nickname with the human (e.g. `gpu-1`, `ci-runner`, `jayam-laptop`); it is how everyone will recognise this machine.

```sh
# Linux (also lets plainsight run `tailscale serve` without sudo)
sudo tailscale up --auth-key="$(cat /tmp/ps-key)" --advertise-tags=tag:plainsight --hostname=ps-<nick> --operator=$USER
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

Different subscriptions are never mixed, including two subscriptions of the same provider. Usage from an install logged into an untracked account is ignored.

## Step 6: Initialise

```sh
plainsight init --nick "<nick>" --operator "<who uses this machine>" \
  --track "claude|/home/me/.claude|Max (Jayam)|2026-03-29" \
  --track "codex|/home/me/.codex|Team Codex"
```

- Format: `PROVIDER|DIR|LABEL|SINCE`, with `|` as separator (Windows paths contain `:`). Use the exact DIR printed by discover.
- Re-running `init` replaces the tracked list and keeps the machine's identity.

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

## Step 8: Verify

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
- on boxes: hosting `svc:plainsight`

The dashboard is at `http://127.0.0.1:4748` locally. Inside the tailnet it is at `https://plainsight.<tailnet>.ts.net` and at any custom domain.

The first box hosting the service may show "not hosting" for a minute until Tailscale approves it (auto-approved by the pool policy).

## Step 9: Report to the human

Tell them, in a few lines:
- the machine's nickname
- what is tracked: label, provider, since
- whether it joined as tagged or untagged
- which peers it synced with
- the dashboard URLs
- anything that failed and the exact fix

Mention that Claude Code / Codex sessions must be restarted to pick up the MCP server and skill.

## Repair, update, uninstall

- Update: `plainsight update` (git pull + restart).
- Daemon not running: `plainsight ensure`, then read `~/.plainsight/daemon.log`.
- Track something else: re-run `plainsight init ...`, then `plainsight restart`.
- Uninstall: `plainsight uninstall` (add `--purge` to delete local data). Then remove the hook and MCP entries it lists. Box: `sudo tailscale logout` (ephemeral nodes also disappear on their own after going offline).

More detail: `~/.plainsight/app/README.md`, `docs/TAILNET.md`, `docs/JOIN.md`, `docs/TROUBLESHOOTING.md`.
