# <img src="assets/icon-512.png" width="40" height="40" alt="" align="top"> plainsight

**See how your team's Claude Code and Codex subscriptions are used, across every machine that uses them. No server, no prompts, just numbers.**

plainsight runs on every machine that uses your team's (or your own) Claude Code or Codex subscriptions. It reads each machine's local usage logs and shares only the numbers with your other machines, peer to peer over [Tailscale](https://tailscale.com):
- tokens by type
- API-equivalent cost
- model
- session timing
- which machine, which subscription

Every machine ends up with the full picture. The dashboard is one address, e.g. `https://usage.example.com`, behind a login, served through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) by whichever of your machines is on.

- **Who is using it right now:** live sessions per machine, with running time, model and tokens. Optional live streaming.
- **How much was used:** 5h, 24h, 7d, 30d and 90d windows, split by subscription, machine, model, day and token type. Cost is an API-equivalent estimate.
- **Heads-up for heavy work:** a machine (or its agent) can announce "overnight run, 8h". Every dashboard then warns that the shared limit will probably run out.
- **Many subscriptions, never mixed:** each Claude or Codex account is its own subscription. Two Claude subscriptions are never added together.
- **History from day one:** first start backfills existing logs. Claude history is filtered by start date; Codex history by the account recorded on each session.
- **One dashboard URL, any device:** sign in with an emailed code or Google. Phones need no Tailscale. It stays up while any machine in the tunnel is on, and shows a calm "No machine is online" page when none is.
- **MCP server** (stdio, no open sockets) so Claude Code / Codex can answer "who is using the Max plan right now?" and announce heavy work themselves.
- **Private by construction:** prompt text, code, file paths and tool arguments never leave the machine. See [What is shared](#what-is-shared).
- **No single point of failure:** no central server or database. Any machine can be offline; the rest keep working and catch up when it returns.

## What you need

| | |
|---|---|
| **A Tailscale tailnet you administer** | The free plan is fine. Tailscale carries the usage sync |
| **At least one box** | A machine tagged `tag:plainsight`. Only boxes accept sync connections. Your personal (untagged) machines connect out to boxes and never to each other, so **without a box nothing is shared**. Any machine can be a box; one that is always on is best |
| **A domain whose DNS is on Cloudflare** | Only for the shared dashboard URL. The domain is the only real cost. Without it, sync still works and every machine has its local dashboard |
| **Cloudflare Zero Trust Free** | For the dashboard login. It may ask for a payment card; nothing is charged on Free |
| **Node.js 20+** and git | No npm dependencies |
| **OS** | Windows, macOS or Linux. plainsight itself needs no admin rights on Windows (installing Tailscale may) |
| **Time** | Owner, first time: about 20–30 minutes, including Cloudflare and optional Google sign-in. Each extra box: about 5 minutes |

---

## Contents

- [What you need](#what-you-need)
- [Quick start (hand this to your agent)](#quick-start-hand-this-to-your-agent)
- [How it works](#how-it-works)
- [What is shared](#what-is-shared)
- [Setup paths](#setup-paths)
- [The dashboard](#the-dashboard)
- [MCP server](#mcp-server)
- [CLI reference](#cli-reference)
- [Subscriptions and accounts](#subscriptions-and-accounts)
- [History backfill](#history-backfill)
- [Costs and prices](#costs-and-prices)
- [Security model](#security-model)
- [Secrets](#secrets)
- [Limits and requirements](#limits-and-requirements)
- [FAQ](#faq)
- Docs: [Tailnet setup (owner)](docs/TAILNET.md) · [Dashboard and login (owner)](docs/DASHBOARD.md) · [Joining a machine by hand](docs/JOIN.md) · [Architecture and protocol](docs/ARCHITECTURE.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

---

## Quick start (hand this to your agent)

Paste this into Claude Code or Codex on the machine you want to add:

> Set up plainsight on this machine. Clone https://github.com/JayceeGupta/plainsight to `~/.plainsight/app` (Windows: `%USERPROFILE%\.plainsight\app`), then read and follow `skills/plainsight-setup/SKILL.md` in it step by step. Ask me before installing software, ask me which Claude/Codex installs to track and what to call them, and never print any keys or tokens. I'll give you the Tailscale auth key and the tunnel token privately, in files, when you need them.

For the **first machine of a new pool** (you own the tailnet and the Cloudflare domain), add: *"This is my own computer and the first machine; start a new pool (Path A) and set up the dashboard. I'll give you a Tailscale API access token and a Cloudflare API token in files."* Then add at least one box (Path B), or nothing is shared.

The agent follows [skills/plainsight-setup/SKILL.md](skills/plainsight-setup/SKILL.md). That is the full procedure, so you can also follow it yourself. The clone step:

```sh
# macOS / Linux
git clone https://github.com/JayceeGupta/plainsight ~/.plainsight/app
```

```powershell
# Windows PowerShell
git clone https://github.com/JayceeGupta/plainsight "$env:USERPROFILE\.plainsight\app"
``` After setup, the [runtime skill](skills/plainsight/SKILL.md) teaches agents to announce heavy work and answer usage questions.

---

## How it works

```
  phone / laptop browser ── https://usage.example.com
            │
            ▼
  Cloudflare Access (login) ─► Worker "plainsight-gate" (offline page) ─► Tunnel "plainsight"
                                                                               │
            ┌────────────── any connector that is up ──────────────────────────┤
            ▼                                ▼                                 ▼
 box A (tag:plainsight)           box B (tag:plainsight)           your computer (untagged)
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ Claude/Codex logs      │       │ Claude/Codex logs      │       │ Claude/Codex logs      │
│   │ collector (numbers)│gossip │   │                    │ dials │   │                    │
│   ▼                    │◄─────►│   ▼                    │◄──────┤   ▼                    │
│ log/A log/B log/you    │ :4747 │ log/A log/B log/you    │  out  │ log/A log/B log/you    │
│ cloudflared ─► :4749   │       │ cloudflared ─► :4749   │       │ cloudflared ─► :4749   │
└────────────────────────┘       └────────────────────────┘       └────────────────────────┘
        └──────────────── Tailscale: usage sync only ─────────────────────┘
```

1. **Collect.** The daemon tails Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) and Codex rollouts (`~/.codex/sessions/**/rollout-*.jsonl`) from saved byte offsets. It turns each API response into one small event (model, token counts, hashed session id, time) and drops everything else.
2. **Store.** Events go into an append-only log, one file per machine: `~/.plainsight/log/<machine-id>.jsonl`. Only that machine ever writes its own file.
3. **Gossip (Tailscale).** Every 60 seconds, and 2 seconds after any new local event, the daemon asks each online peer which events it already has, then both sides exchange whatever the other is missing. Each file has a single writer, so merging is a plain union with no conflicts. Machines can come and go in any order and still converge. Boxes are tagged `tag:plainsight` and reach each other only on tcp:4747. Your own computers stay untagged and connect out to boxes; they never connect to each other, so at least one box must exist.
4. **Serve (Cloudflare).** Every machine that has the tunnel token runs `cloudflared`, which connects out to Cloudflare as one connector of the tunnel `plainsight`. Cloudflare sends each visitor, after login, to any connector that is up. The connector forwards only to the daemon's read-only view on `127.0.0.1:4749`. A machine joins the tunnel only after its first successful sync, so nobody sees a half-empty copy.
5. **Ask.** `plainsight mcp` is a stdio MCP server that reads the same merged logs. It opens no network listener and works even if the daemon is down.

Peers are found with `tailscale status`: any online device tagged `tag:plainsight`. There is nothing to configure per peer. Full protocol and data model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## What is shared

Each usage event contains only:

| Field | Example | Notes |
|---|---|---|
| machine id | `43c6701919bb3cc6` | random, generated at install |
| time | `1762434000000` | when the API response was logged |
| provider | `claude` / `codex` | |
| subscription id | `d52715f0ab9db137` | SHA-256 of provider + account id, truncated. Not reversible to an email |
| session id | `9f2c1a0b44e1` | SHA-256 of the session id, truncated |
| model | `claude-opus-5-5` | |
| tokens | input, cache read, cache write, output, reasoning | integers |

Each machine also publishes:
- its nickname, OS, hostname, operator name and plainsight version
- subscription labels you choose
- machine colours you pick
- announcements you write
- a heartbeat every 2 minutes

**Never shared:**
- prompts or responses
- code, file names, paths or working directories
- tool names and arguments
- git info
- emails
- API keys or OAuth tokens

`plainsight discover` reads account emails **locally** to help you choose; they are not stored or sent.

---

## Setup paths

| Path | Who | What happens |
|---|---|---|
| **A: Start a pool** | Owner, once | Tailscale: `plainsight pool bootstrap` isolates `tag:plainsight` devices in your tailnet policy (sync only), `pool key` mints a reusable auth key ([docs/TAILNET.md](docs/TAILNET.md)). Cloudflare: `plainsight cloudflare setup` creates the tunnel, login and DNS for the dashboard ([docs/DASHBOARD.md](docs/DASHBOARD.md)) |
| **B: Join as a box** | Any machine that should accept sync: a server, a shared workstation, a CI runner. At least one per pool; always-on is best | Install Tailscale, `tailscale up --auth-key=file:KEYFILE --advertise-tags=tag:plainsight`, clone, `init`, `install`, then `tunnel join --token-file F` with the tunnel token from the owner. Boxes reach only each other, on the sync port ([docs/JOIN.md](docs/JOIN.md)) |
| **C: Personal device** | Your own computers, any number | Stay normal tailnet devices and connect out to boxes to share their usage. No policy change per device: bootstrap lets every member device reach boxes on tcp:4747. The owner's computer is usually where you run `cloudflare setup`, so it holds the tunnel token and serves the dashboard too |

Agents should follow [skills/plainsight-setup/SKILL.md](skills/plainsight-setup/SKILL.md), which covers all three paths.

---

## The dashboard

Open it at:
- **`https://<hostname>`**, e.g. `https://usage.example.com`, from any browser or phone, after signing in. No Tailscale needed on the device. It works whenever at least one machine with the tunnel token is on: your computer or any box. When none is, the page says "No machine is online" and checks again every 20 seconds. Set up with [docs/DASHBOARD.md](docs/DASHBOARD.md).
- **`http://127.0.0.1:4748`** on any machine running plainsight. Always works, even offline. This is the only place where you can change machine colours for everyone.

`plainsight url` prints both.

**Sign-in.** Cloudflare Access asks for an email address and sends a one-time code, and/or offers "Sign in with Google". Only addresses or email domains you allowed get in (`plainsight access add …`). A sign-in lasts 30 days by default (`plainsight access session`).

**Read-only.** Everything that arrives through the tunnel can only view. It reaches a separate listener that answers `GET` only. Announcing, stopping and colour changes exist only on `127.0.0.1:4748`, which is never published.

The page is built for phones too. Open it once and use the browser's *Add to Home screen* for a full-screen black app.

**Top bar:**
- **Filters:** `plainsight / Subscriptions ▾ / Machines ▾ / Providers ▾` (multi-select).
- **Period:** `5h` (the rolling limit window), `24h`, `7d`, `30d`, `90d`.
- **Metric:** `Cost` or `Tokens`.
- **Live:** streams updates via Server-Sent Events as soon as any machine records usage.

**Sections:**
- **Announcements:** heavy-work banners with machine, operator, message and end time.
- **Headline and chart:** the total per subscription with a per-machine split. One chart per subscription, stacked by machine, with a tooltip (hover, or tap on a phone).
- **Machines:** one row per machine, sorted by in use, then online, then last seen. Each row shows the state (in use, online, or offline and since when), operator, OS, version, and its usage per subscription (with its share when one subscription is selected). The machine serving the page is marked. Its live sessions are grouped underneath: model, subscription, how long the current stretch of activity has run, time since last activity, tokens and cost. Sessions count as live for 10 minutes after their last activity.
- **Machine colours:** every machine gets its own colour, assigned oldest-first so it never changes as machines come and go. It is used in the charts, the filter menu and the machines list. Click a machine's dot to change it. On `127.0.0.1:4748` (or `plainsight color`) the change applies on every machine; on the public URL it is saved in that browser only.
- **Totals:** per subscription: processed tokens, cached input, uncached input, output and cache savings.
- **Cost or tokens by type:** one bar per subscription.
- **Breakdown:** by model, or by day (hour for short periods). Shares are computed within each subscription. Click a model for its detail: cost, tokens, cost per 1M tokens, cache hit rate, cost and tokens by type.
- **Footer:** how many machines are known and online, and which machine served the page.

Filters, period and metric are remembered per browser.

---

## MCP server

`plainsight install` registers it for Claude Code (`claude mcp add --scope user plainsight`) and Codex (`[mcp_servers.plainsight]` in `config.toml`). Transport is **stdio**, so there is no listening socket and no long-lived connection. It speaks MCP `2025-11-25` and negotiates down to `2024-11-05`.

| Tool | Arguments | Returns |
|---|---|---|
| `live` | `subscription?`, `machine?`, `provider?` | Active sessions (last 10 min), current announcements, machines online |
| `usage` | `range` (`1h`/`5h`/`24h`/`7d`/`30d`/`90d`), `subscription?`, `machine?`, `provider?` | Per subscription: cost, tokens by type, sessions, requests, cache savings, per-machine and per-model splits |
| `machines` | none | Every machine: nickname, operator, online, last seen, OS, subscriptions |
| `announce` | `message`, `hours`, `heavy?` | Publishes a heavy-work announcement from this machine (needs the local daemon) |

Manual registration elsewhere:

```sh
# macOS / Linux
claude mcp add --scope user plainsight -- node ~/.plainsight/app/bin/plainsight.js mcp
codex mcp add plainsight -- node ~/.plainsight/app/bin/plainsight.js mcp
```

```powershell
# Windows PowerShell
claude mcp add --scope user plainsight -- node "$env:USERPROFILE\.plainsight\app\bin\plainsight.js" mcp
codex mcp add plainsight -- node "$env:USERPROFILE\.plainsight\app\bin\plainsight.js" mcp
```

---

## CLI reference

`plainsight install` puts a `plainsight` command on your PATH. Every command below is written that way. Before install (`discover`, `init`, `install` itself), run it through node:

| OS | Before install | After install |
|---|---|---|
| macOS / Linux | `node ~/.plainsight/app/bin/plainsight.js …` | `plainsight …` (symlink `~/.local/bin/plainsight`; install prints a hint if `~/.local/bin` is not on your PATH) |
| Windows (PowerShell) | `node "$env:USERPROFILE\.plainsight\app\bin\plainsight.js" …` | `plainsight …` in a **new** terminal (`%USERPROFILE%\.plainsight\bin\plainsight.cmd`, added to your user PATH) |

On Windows, `node ~/.plainsight/…` does not work: PowerShell and cmd do not expand `~` for node. The repo also ships `bin\plainsight.cmd`, which runs `node plainsight.js` from its own folder.

**Setup and running**

| Command | What it does |
|---|---|
| `discover [--json]` | List Claude Code / Codex installs, logged-in account, subscription id, start date and history size |
| `init --nick N [--operator WHO] --track "PROVIDER\|DIR\|LABEL\|SINCE" … [--port N] [--web-port N]` | Write this machine's config. Repeat `--track`. `SINCE` optional (ISO date). `--port`: sync port (default 4747; keep it on every machine, the policy allows only tcp:4747). `--web-port`: local dashboard port (default 4748; the read-only view uses web port + 1). Re-running replaces the config but keeps the machine id and ports |
| `install` | Hook + MCP + skill for each tracked install, the `plainsight` command, background service, start daemon |
| `uninstall [--purge [--yes]]` | Stop the daemon; remove the service or logon launcher, the SessionStart hook, the MCP registration, the skill(s), the `plainsight` command and the tunnel token. Keeps `~/.plainsight`. See [Uninstall](#uninstall) |
| `daemon` | Run in the foreground |
| `ensure` | Start the daemon if it is not answering (the SessionStart hook runs `ensure --quiet`). Goes through systemd / launchd when the service is installed |
| `stop`, `restart` | Stop / restart the daemon (and with it this machine's tunnel connector). With the service installed they go through `systemctl --user` / `launchctl`, so `stop` really stops it and no second daemon appears |
| `status [--json]` | Daemon, Tailscale, peers, last sync per peer, tunnel state, event counts, tracked subscriptions |
| `doctor` | Checks every requirement, including the tunnel connector, and prints the fix for each failure |
| `url` | Dashboard URLs: `http://127.0.0.1:4748` and `https://<hostname>` |
| `announce "MSG" [--hours N] [--light]` | Heavy-work announcement (default 4h, heavy) |
| `color MACHINE #rrggbb` | Set a machine's dashboard colour everywhere |
| `label SUB "NEW LABEL"` | Rename a subscription (by id or label) on every machine. Restarts the daemon to publish it |
| `mcp` | MCP server on stdio |
| `update` | `git pull --ff-only`, then refresh with the new code: re-copy skills, refresh the hook, MCP registration and `plainsight` command, restart the daemon |

**Dashboard tunnel** (every machine that should be able to show the dashboard)

| Command | What it does |
|---|---|
| `tunnel join --token-file F` | Store the tunnel token from the owner at `~/.plainsight/tunnel-token` (mode 600) and restart the daemon. It joins after its first sync |
| `tunnel leave` | Delete the token and restart without the connector. The machine keeps sharing usage |
| `tunnel status` | JSON: configured, running, pid, since, restarts, last error, synced |

**Tailnet owner** (once per pool; needs a Tailscale API access token in a file)

| Command | What it does |
|---|---|
| `pool bootstrap --token-file F [--apply] [--force]` | Isolate `tag:plainsight` for sync only; your devices may connect out to boxes on tcp:4747. Dry run unless `--apply`; `--force` if your policy is not the default. Safe to re-run. Refuses, changing nothing, if the policy has old-style `acls` rules. Removes 0.1's `svc:plainsight` and viewer rules |
| `pool key --token-file F [--out FILE] [--days 90] [--ephemeral]` | Mint a reusable, pre-approved, non-ephemeral `tag:plainsight` auth key into a file (default `~/.plainsight/tailscale-authkey.txt`). `--ephemeral` only for throwaway CI or containers |

**Cloudflare owner** (needs a Cloudflare API token: `--token-file F` or `CLOUDFLARE_API_TOKEN`; [permissions](docs/DASHBOARD.md#cloudflare-api-token))

| Command | What it does |
|---|---|
| `cloudflare setup --hostname H [--email E[,E..]] [--domain D] [--session 720h] [--google-client-id ID --google-secret-file F] [--account ID]` | Tunnel, DNS, Access login and the offline-page Worker. Saves the tunnel token on this machine. Safe to re-run with the same options |
| `cloudflare status` | URL, sign-in options, session length, who is allowed, connected connectors |
| `cloudflare tunnel-token [--out F]` | Write the tunnel token to a file (default `~/.plainsight/tunnel-token.for-box`), to hand to a box |
| `cloudflare teardown --yes` | Remove the Worker and its routes, Access app and policy, DNS record and tunnel. Keeps identity providers and Zero Trust |
| `access list` | Allowed emails and email domains |
| `access add EMAIL [EMAIL..]` | Allow these addresses |
| `access remove EMAIL [EMAIL..]` | Disallow them and sign them out now |
| `access allow-domain D [--i-understand]`, `access remove-domain D` | Allow / stop allowing every address `@D`. Refuses public email providers (gmail.com, outlook.com, …) unless `--i-understand` |
| `access login google\|code\|both` | Which sign-in options the login page offers |
| `access google --client-id ID --client-secret-file F` | Add or replace "Sign in with Google" |
| `access session DURATION` | How long a sign-in lasts, e.g. `24h`, `168h`, `720h` |
| `access revoke [EMAIL]` | Sign out one person, or everyone, immediately |

Environment variables:

| Variable | Purpose |
|---|---|
| `PLAINSIGHT_HOME` | Data dir (default `~/.plainsight`) |
| `PLAINSIGHT_TAILSCALE` | Path to the `tailscale` binary |
| `PLAINSIGHT_SOCKS` | `host:port` of tailscaled's SOCKS5 proxy (userspace networking) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token for `cloudflare` / `access` commands, instead of `--token-file` |

Config (`~/.plainsight/config.json`):

| Key | Meaning |
|---|---|
| `nodeId` | Random id for this machine |
| `nickname`, `operator` | Display names |
| `port` | Sync port, 4747 (on the box's Tailscale IP and 127.0.0.1). `init --port N` |
| `webPort` | Local dashboard with control endpoints, 4748 (127.0.0.1 only, never published). `init --web-port N` |
| `viewPort` | Read-only view the tunnel forwards to (default `webPort + 1`, i.e. 4749). Keep it the same on every machine |
| `tracked[]` | `{provider, dir, sub, label, since}` |
| `cloudflare` | Set by `cloudflare setup` on the owner's machine: `{accountId, zoneId, hostname, tunnelId, appId, policyId, authDomain, session}`. Ids only, no secrets |
| `tunnelTokenFile` | Where the tunnel token lives (default `~/.plainsight/tunnel-token`) |
| `cloudflared` | Path to a `cloudflared` binary to use. Default: `cloudflared` on `PATH`, else one downloaded from the latest GitHub release to `~/.plainsight/bin` and checked against the SHA-256 in the release notes (refused if missing or different; then install `cloudflared` yourself) |

`init` rewrites `config.json` but keeps the machine's identity, its ports and its dashboard settings (`cloudflare`, `tunnelTokenFile`, `cloudflared`, `viewPort`).

### Uninstall

| Command | Removes | Keeps |
|---|---|---|
| `plainsight uninstall` | Stops the daemon. Removes the service (systemd unit / LaunchAgent / Windows Startup launcher), the SessionStart hook, the MCP registration, the `plainsight` skill, the `plainsight` command and the tunnel token | `~/.plainsight` (code, config, your copy of the usage data) |
| `plainsight uninstall --purge` | All of the above, plus `~/.plainsight`: the code, the usage copy, the config (including the Cloudflare ids `cloudflare teardown` needs), the Tailscale auth key file and policy backups | Nothing local |

- On the machine that ran `cloudflare setup`, `--purge` refuses without `--yes`. If you want the dashboard gone too, run `plainsight cloudflare teardown --yes` first; after a purge the ids it needs are gone.
- `cleanupPeriodDays` stays as install set it. `settings.json.bak-plainsight` next to each `settings.json` is the copy from before install.
- A box also leaves the tailnet with `tailscale logout` (or admin console → Machines → *Remove*).

---

## Subscriptions and accounts

- A **subscription** is one provider account: `sha256("plainsight:<provider>:<account id>")`.
  - Claude Code: `oauthAccount.accountUuid` from `~/.claude.json`, or `<CLAUDE_CONFIG_DIR>/.claude.json`.
  - Codex: `tokens.account_id` from `~/.codex/auth.json`.

  The same account on any machine gives the same subscription. Different accounts never collide.
- Every usage event carries its subscription id. All dashboard and MCP totals are computed per subscription and never summed across subscriptions.
- One machine can track several installs, e.g. `~/.claude` on a Max plan and `~/.claude-work` with `CLAUDE_CONFIG_DIR` on another account.
- **Account switches.**
  - Codex logs record the account per session. Only sessions from the tracked account count.
  - Claude Code logs don't record the account. After install, plainsight only accepts new Claude usage while the install is logged into the tracked account (it reads logs within seconds of them being written).
  - For history, it uses the `since` date you set.
- **Labels** are set by whichever machine tracks the subscription; the latest one wins. Rename with `plainsight label`.

## History backfill

The first daemon start reads every existing transcript, so the dashboard has history from day one. Backfilled events are marked `bf: 1`.

- **Claude Code** deletes transcripts after 30 days by default. `plainsight install` sets `cleanupPeriodDays: 3650` in each tracked install's `settings.json` to stop that. History deleted before install is gone.
- **Codex** keeps sessions until you delete them.
- Re-running is safe: events are deduplicated by message/response id.

## Costs and prices

- **Source.** Cost is the API price of the tokens, from [LiteLLM's public price table](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json). It is fetched at most every 6 hours and cached in `~/.plainsight/prices-cache.json`.
- **Meaning.** Subscriptions are flat-rate, so read cost as value used, not money spent.
- **Unknown models** show as **Unpriced**. Their tokens still count.
- **Overrides.** Add `~/.plainsight/prices.json`:

  ```json
  { "my-model": { "input": 3e-6, "output": 15e-6, "cacheRead": 3e-7, "cacheWrite": 3.75e-6 } }
  ```

  Values are USD per token.
- **Applied at view time.** Fixing a price fixes all history. Overrides are per machine; copy the file to every box for a consistent view.
- **Cache savings** = cache-read tokens × (input price − cache-read price).

## Security model

- **Data sharing is isolated by Tailscale policy** ([docs/TAILNET.md](docs/TAILNET.md)):
  - Boxes are tagged `tag:plainsight` and can only reach other boxes on tcp:4747.
  - Boxes cannot open any connection to your other devices.
  - Your devices (tailnet members) can reach boxes on tcp:4747 only. That is how personal machines sync: they connect out to boxes. Boxes can only reply.
  - The policy contains tests, so a future edit that breaks this is rejected by Tailscale.
- **The dashboard is behind a login** ([docs/DASHBOARD.md](docs/DASHBOARD.md)):
  - Every request to `https://<hostname>` passes Cloudflare Access first. Only allowed emails and email domains get in.
  - `cloudflared` only dials out. No machine opens a port to the internet or needs a public IP.
  - TLS ends at Cloudflare, so Cloudflare can see the dashboard's contents (usage numbers, nicknames, labels, announcements). Never prompts or code.
- **Listeners:**
  - Sync listens only on the box's Tailscale IP and 127.0.0.1. Untagged machines run no sync listener.
  - The local dashboard listens only on 127.0.0.1:4748 and is never published.
  - The read-only view listens only on 127.0.0.1:4749. It is the only thing the tunnel reaches, and it answers `GET`/`HEAD` only (`405` otherwise).
- **Control endpoints** (announce, colour, stop) exist only on 4748 and also require a direct localhost request.
- **Incoming events are validated:** schema, sizes, sequence numbers, no writing as another machine's own origin.
- **Trust:**
  - Every box in the pool is trusted to report honestly. A malicious box could publish fake numbers for its own origin; it cannot alter other machines' history.
  - A machine with the tunnel token can answer dashboard visitors. Give the token only to machines you trust in the pool.
  - Don't put untrusted machines in the pool.

## Secrets

| Secret | Where it lives | Used for | Notes |
|---|---|---|---|
| Tunnel token | `~/.plainsight/tunnel-token` (mode 600) on your computer and every box in the tunnel | Running a connector for the dashboard tunnel | Can run this one tunnel and nothing else. Passed to `cloudflared` in its environment, never on a command line, never printed |
| Tailscale auth key | Owner: `~/.plainsight/tailscale-authkey.txt`, only while you hand it out (optional to keep). Box: a temporary file | `tailscale up --auth-key=file:KEYFILE` on a new box, once | Reusable, so treat it like a password. Delete the box's copy after joining |
| Tailscale API access token | Your file, while you run `pool` commands | `pool bootstrap`, `pool key` | Never stored by plainsight. Create when needed, revoke after |
| Cloudflare API token | Your file or `CLOUDFLARE_API_TOKEN`, while you run `cloudflare` / `access` commands | Setup and access changes | Never stored by plainsight. Create when needed, revoke after |
| Google OAuth client secret | Cloudflare (as the Google identity provider) | "Sign in with Google" | Never stored by plainsight. Delete your local file after `access google` |

## Limits and requirements

- **Software:**
  - Node.js 20+. No npm dependencies.
  - Tailscale, any recent version.
  - `cloudflared` on machines in the tunnel. Downloaded automatically if missing (Linux amd64/arm64/arm, macOS, Windows) and verified against the SHA-256 in the release notes.
  - Claude Code and/or Codex CLI writing local logs.
- **Tailscale plan:**
  - Every box is a tagged device. The free Personal plan was reported in 2026 to allow 50 tagged devices; check [tailscale.com/pricing](https://tailscale.com/pricing).
  - Box keys are not ephemeral by default, so a box that is off for a weekend stays in the tailnet. Remove retired boxes by hand ([docs/TAILNET.md](docs/TAILNET.md#plan-limits-and-housekeeping)). `pool key --ephemeral` is for throwaway CI or containers: Tailscale deletes those devices soon after they go offline.
- **Cloudflare (free apart from the domain):** a domain on Cloudflare, Zero Trust Free (up to 50 people who sign in; it may ask for a card, nothing is charged), Tunnel, DNS, and a Worker on the free plan (100,000 requests/day; about one per page load). Details: [docs/DASHBOARD.md](docs/DASHBOARD.md#costs-and-free-limits).
- **Size and speed:**
  - About 200 bytes per API response. Heavy use is about 1–3 MB per machine per month.
  - Aggregation over 100k events takes about 50 ms.
- **Granularity:**
  - "Live" updates per API response, typically every few seconds while a session works. Per-token streaming would need a proxy, which plainsight deliberately avoids.
  - Rate-limit percentages are not collected. Check them on a machine (`/usage` in Claude Code, the Codex status line).

## FAQ

**Does any machine have to stay on?**
No. Every machine holds a full copy. The dashboard URL works while any machine in the tunnel is on. When all are off, it shows "No machine is online" and retries every 20 seconds; each machine still has its local dashboard at `127.0.0.1:4748`. Personal machines exchange data only through boxes, though: new usage from your laptop reaches the others while at least one box is on. An always-on box is best.

**Can two personal computers sync with each other directly?**
No. Only boxes accept sync connections. Add a box (any machine, tagged `tag:plainsight`), and every personal machine syncs through it.

**What if my computer is off?**
Any box with the tunnel token keeps the dashboard up, with your computer's usage up to its last sync. Your computer catches up when it comes back.

**What if nothing is online?**
Signed-in visitors see the black "No machine is online" page. Usage recorded meanwhile stays on each machine and shows up once one of them reconnects.

**Do phones need Tailscale?**
No. The dashboard is a normal HTTPS site behind a login. Tailscale is only for machines that share usage.

**Who can see the dashboard?**
Only the email addresses and email domains you allow (`plainsight access list`). Up to 50 people on Zero Trust Free.

**What if two machines report the same API call?**
They can't. Each machine only reads its own local logs.

**Same subscription on two machines?**
Normal, and the main use case. Both report into the same subscription, and the dashboard shows the per-machine split.

**Can I use it without Tailscale?**
Sync needs some private network between machines. Tailscale provides discovery, encryption and isolation. Plain LAN peers aren't supported yet.

**Can I skip Cloudflare?**
Yes. Sync works without it, and every machine has its local dashboard at `http://127.0.0.1:4748`. You just don't get the shared URL.

**I used plainsight 0.1 (dashboard inside Tailscale).**
See [Upgrading from 0.1](docs/TAILNET.md#upgrading-from-plainsight-01). The daemon removes its old `tailscale serve` entries by itself; re-run `pool bootstrap --apply --force` once, then set up the dashboard with [docs/DASHBOARD.md](docs/DASHBOARD.md).

**Other providers (Gemini CLI, OpenCode, Cursor…)?**
The collector is an adapter per provider ([src/collect/parsers.js](src/collect/parsers.js)): a function from log lines to usage events, plus an account reader in [src/discover.js](src/discover.js). PRs welcome.

## License

MIT
