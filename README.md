# plainsight

**Everyone sharing an AI coding subscription can see how it is being used. No server, no prompts, just numbers.**

plainsight runs on every machine that uses your Claude Code or Codex subscriptions. It reads each machine's local usage logs and shares only the numbers with your other machines, peer to peer over [Tailscale](https://tailscale.com):
- tokens by type
- API-equivalent cost
- model
- session timing
- which machine, which subscription

Every machine ends up with the full picture, so any one of them can show the dashboard, even after the others go offline.

- **Who is using it right now:** live sessions per machine, with running time, model and tokens. Optional live streaming.
- **How much was used:** 5h, 24h, 7d, 30d and 90d windows, split by subscription, machine, model, day and token type. Cost is an API-equivalent estimate.
- **Heads-up for heavy work:** a machine (or its agent) can announce "overnight run, 8h". Every dashboard then warns that the shared limit will probably run out.
- **Many subscriptions, never mixed:** each Claude or Codex account is its own subscription. Two Claude subscriptions are never added together.
- **History from day one:** first start backfills existing logs. Claude history is filtered by start date; Codex history by the account recorded on each session.
- **MCP server** (stdio, no open sockets) so Claude Code / Codex can answer "who is using the Max plan right now?" and announce heavy work themselves.
- **Private by construction:** prompt text, code, file paths and tool arguments never leave the machine. See [What is shared](#what-is-shared).
- **No single point of failure:** no central server or database. Any machine can be offline; the rest keep working and catch up when it returns.

---

## Contents

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
- [Limits and requirements](#limits-and-requirements)
- [FAQ](#faq)
- Docs: [Tailnet setup (owner)](docs/TAILNET.md) · [Joining a machine by hand](docs/JOIN.md) · [Architecture and protocol](docs/ARCHITECTURE.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

---

## Quick start (hand this to your agent)

Paste this into Claude Code or Codex on the machine you want to add:

> Set up plainsight on this machine. Clone https://github.com/JayceeGupta/plainsight to `~/.plainsight/app` (Windows: `%USERPROFILE%\.plainsight\app`), then read and follow `skills/plainsight-setup/SKILL.md` in it step by step. Ask me before installing software, ask me which Claude/Codex installs to track and what to call them, and never print any keys or tokens. I'll give you the Tailscale auth key privately when you need it.

For the **first machine of a new pool** (you own the tailnet), add: *"This is the first machine; start a new pool (Path A). I'll give you a Tailscale API access token in a file."*

The agent follows [skills/plainsight-setup/SKILL.md](skills/plainsight-setup/SKILL.md). That is the full procedure, so you can also follow it yourself. After setup, the [runtime skill](skills/plainsight/SKILL.md) teaches agents to announce heavy work and answer usage questions.

---

## How it works

```
 machine A (box)                          machine B (box)                     your laptop (admin)
┌──────────────────────────┐            ┌──────────────────────────┐        ┌───────────────────────┐
│ Claude/Codex local logs  │            │ Claude/Codex local logs  │        │ local logs            │
│   │ collector (numbers)  │  gossip    │   │                      │        │   │                   │
│   ▼                      │◄──────────►│   ▼                      │◄───────┤   ▼  (dials out only) │
│ log/A.jsonl  log/B.jsonl │ tcp:4747   │ log/A.jsonl  log/B.jsonl │        │ log/A,B,laptop.jsonl  │
│ log/laptop.jsonl         │            │ log/laptop.jsonl         │        │                       │
│ dashboard :4748 ─────────┼── svc:plainsight (Tailscale Service) ─┼────────► browser / phone       │
└──────────────────────────┘            └──────────────────────────┘        └───────────────────────┘
```

1. **Collect.** The daemon tails Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) and Codex rollouts (`~/.codex/sessions/**/rollout-*.jsonl`) from saved byte offsets. It turns each API response into one small event (model, token counts, hashed session id, time) and drops everything else.
2. **Store.** Events go into an append-only log, one file per machine: `~/.plainsight/log/<machine-id>.jsonl`. Only that machine ever writes its own file.
3. **Gossip.** Every 60 seconds, and 2 seconds after any new local event, the daemon asks each online peer which events it already has, then both sides exchange whatever the other is missing. Each file has a single writer, so merging is a plain union with no conflicts. Machines can come and go in any order and still converge.
4. **Serve.** Tagged boxes publish the dashboard as one Tailscale Service, `svc:plainsight`, with a stable tailnet IP. Tailscale routes each visitor to whichever box is online. You can point your own domain at it; it only loads for devices on your tailnet.
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
| **A: Start a pool** | Tailnet owner, once | `plainsight pool bootstrap` isolates `tag:plainsight` devices in your tailnet policy, defines `svc:plainsight` and mints a reusable auth key. [docs/TAILNET.md](docs/TAILNET.md) |
| **B: Join as a box** | Any shared or ephemeral machine | Install Tailscale, `tailscale up --auth-key=… --advertise-tags=tag:plainsight`, clone, `init`, `install`. Boxes can only see each other. [docs/JOIN.md](docs/JOIN.md) |
| **C: Personal device** | The owner's own computer | Stays a normal tailnet device and dials out to boxes to share its usage. Needs its IP in the policy's `plainsight-admin` host. |

Agents should follow [skills/plainsight-setup/SKILL.md](skills/plainsight-setup/SKILL.md), which covers all three paths.

---

## The dashboard

Open it at any of:
- `http://127.0.0.1:4748` on any machine running plainsight
- `https://plainsight.<your-tailnet>.ts.net` from any device on your tailnet (phone included), while at least one box is online
- `https://<your-computer>.<your-tailnet>.ts.net:4748` while your own (untagged) computer is on. Its daemon publishes the dashboard there automatically, tailnet-only, so your phone works even when no box is online. `plainsight url` prints the exact address.
- your custom domain, e.g. `http://usage.example.com`, if you set one up. Your computer can keep it pointed at whichever host is up ([docs/TAILNET.md](docs/TAILNET.md#custom-domain)).

Every way in is **read-only**: anything that arrives through Tailscale can only view. To give a phone (yours or someone else's) access to the dashboard and nothing else, see [View-only devices](docs/TAILNET.md#view-only-devices-phones).

The page is built for phones too. Open it once and use the browser's *Add to Home screen* for a full-screen black app.

**Top bar:**
- **Filters:** `plainsight / Subscriptions ▾ / Machines ▾ / Providers ▾` (multi-select).
- **Period:** `5h` (the rolling limit window), `24h`, `7 days`, `30 days`, `90 days`.
- **Metric:** `Cost` or `Tokens`.
- **Live:** streams updates via Server-Sent Events as soon as any machine records usage.

**Sections:**
- **Announcements:** heavy-work banners with machine, operator, message and end time.
- **Using it right now:** sessions active in the last 10 minutes. Shows machine, subscription, model, how long the current stretch of activity has run, time since last activity, tokens and cost.
- **Machine colours:** every machine gets its own colour, assigned oldest-first so it never changes as machines come and go. It is used in the chart, the filter menu, the live cards, the breakdown and the machine cards.
- **Headline and chart:** the total per subscription with a per-machine split. One chart per subscription, stacked by machine, with a tooltip (hover, or tap on a phone).
- **Totals:** per subscription: processed tokens, cached input, uncached input, output and cache savings.
- **Cost or tokens by type:** one bar per subscription.
- **Breakdown:** by model, by machine, or by day or hour. Shares are computed within each subscription. Click a model for its detail: cost, tokens, cost per 1M tokens, cache hit rate, cost and tokens by type.
- **Machines:** online state, last seen, operator, OS, version, subscriptions used.

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
claude mcp add --scope user plainsight -- node ~/.plainsight/app/bin/plainsight.js mcp
codex mcp add plainsight -- node ~/.plainsight/app/bin/plainsight.js mcp
```

---

## CLI reference

`plainsight` below means `node ~/.plainsight/app/bin/plainsight.js`.

| Command | What it does |
|---|---|
| `discover [--json]` | List Claude Code / Codex installs, logged-in account, subscription id, start date and history size |
| `init --nick N [--operator WHO] --track "PROVIDER\|DIR\|LABEL\|SINCE" …` | Write this machine's config. Repeat `--track`. `SINCE` optional (ISO date) |
| `install` | Hook + MCP + skill for each tracked install, background service, start daemon |
| `uninstall [--purge]` | Stop and remove the service (`--purge` deletes `~/.plainsight`) |
| `daemon` | Run in the foreground |
| `ensure` | Start the daemon if it is not answering (used by the SessionStart hook) |
| `stop`, `restart` | Stop / restart the daemon |
| `status [--json]` | Daemon, Tailscale, peers, last sync per peer, event counts, tracked subscriptions |
| `doctor` | Checks every requirement and prints the fix for each failure |
| `url` | Dashboard URLs |
| `announce "MSG" [--hours N] [--light]` | Heavy-work announcement (default 4h, heavy) |
| `label SUB "NEW LABEL"` | Rename a subscription (by id or label) on every machine |
| `mcp` | MCP server on stdio |
| `update` | `git pull --ff-only` + restart |
| `pool bootstrap --token-file F [--admin-ip IP] [--apply] [--force]` | Owner: isolate `tag:plainsight`, define `svc:plainsight` (dry run unless `--apply`) |
| `pool key --token-file F [--out FILE] [--days 90]` | Owner: mint a reusable, ephemeral, pre-approved `tag:plainsight` auth key into a file |

Environment variables:

| Variable | Purpose |
|---|---|
| `PLAINSIGHT_HOME` | Data dir (default `~/.plainsight`) |
| `PLAINSIGHT_TAILSCALE` | Path to the `tailscale` binary |
| `PLAINSIGHT_SOCKS` | `host:port` of tailscaled's SOCKS5 proxy (userspace networking) |

Config (`~/.plainsight/config.json`):

| Key | Meaning |
|---|---|
| `nodeId` | Random id for this machine |
| `nickname`, `operator` | Display names |
| `port` | Sync port, 4747 |
| `webPort` | Dashboard port, 4748 (localhost) |
| `hostService` | Set `false` to stop this box from hosting the dashboard service |
| `serveTailnet` | Untagged machines only. Set `false` to stop publishing the dashboard at `https://<this-machine>.<tailnet>.ts.net:4748` |
| `tailnetHttpPort` | Untagged machines: raw TCP port for custom domains (default 80, `false` disables) |
| `viewPort` | Local read-only listener that everything on the tailnet is forwarded to (default `webPort + 1`) |
| `dns` | Custom-domain follower, set by `plainsight dns` |
| `tailnetPort` | Port for that address (default: `webPort`). plainsight never takes over a port something else already serves, and never a Funnel (public) port |
| `tracked[]` | `{provider, dir, sub, label, since}` |

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

- **Network isolation is Tailscale policy** ([docs/TAILNET.md](docs/TAILNET.md)):
  - Boxes are tagged `tag:plainsight` and can only reach other boxes on tcp:4747.
  - They cannot reach or even see the owner's other devices.
  - Owner devices reach boxes only through `svc:plainsight` (80/443), except the optional `plainsight-admin` host.
  - The policy contains tests, so a future edit that breaks this is rejected by Tailscale.
- **Listeners:**
  - Sync listens only on the box's Tailscale IP and 127.0.0.1.
  - The dashboard listens only on 127.0.0.1 and is exposed through `tailscale serve`: the Service on boxes, and `https://<computer>.<tailnet>.ts.net:4748` on untagged machines. Both are tailnet-only, never Funnel.
  - View-only devices (`tag:plainsight-viewer`) can open the dashboard and nothing else, and nothing can connect to them.
- **Read-only from outside.** Control endpoints (announce, stop) only accept direct localhost requests. They refuse anything arriving through a `tailscale serve` proxy.
- **Incoming events are validated:** schema, sizes, sequence numbers, no writing as another machine's own origin.
- **Trust:**
  - Every box in the pool is trusted to report honestly. A malicious box could publish fake numbers for its own origin; it cannot alter other machines' history.
  - Don't put untrusted machines in the pool.
- **Secrets:** the Tailscale auth key is only used at `tailscale up`. The API token is only needed for `pool` commands; revoke it after setup.

## Limits and requirements

- **Software:**
  - Node.js 18.17+ (20+ recommended). No npm dependencies.
  - Tailscale 1.86+ on boxes that host the dashboard service. Any recent version for sync.
  - Claude Code and/or Codex CLI writing local logs.
- **Tailscale plan:**
  - Every box is a tagged device. The free Personal plan was reported in 2026 to allow 50 tagged devices; check [tailscale.com/pricing](https://tailscale.com/pricing).
  - Ephemeral boxes are removed by Tailscale soon after going offline, so they don't pile up.
- **Size and speed:**
  - About 200 bytes per API response. Heavy use is about 1–3 MB per machine per month.
  - Aggregation over 100k events takes about 50 ms.
- **Granularity:**
  - "Live" updates per API response, typically every few seconds while a session works. Per-token streaming would need a proxy, which plainsight deliberately avoids.
  - Rate-limit percentages are not collected. Check them on a machine (`/usage` in Claude Code, the Codex status line).

## FAQ

**Does any machine have to stay on?**
No. Every machine holds a full copy. When a box is online it hosts the dashboard service and syncs. When all boxes are offline, any machine running plainsight still has its local dashboard at `127.0.0.1:4748`.

**What if two machines report the same API call?**
They can't. Each machine only reads its own local logs.

**Same subscription on two machines?**
Normal, and the main use case. Both report into the same subscription, and the dashboard shows the per-machine split.

**Can I use it without Tailscale?**
Sync needs some private network between machines. Tailscale provides discovery, encryption, isolation and the dashboard service. Plain LAN peers aren't supported yet.

**Other providers (Gemini CLI, OpenCode, Cursor…)?**
The collector is an adapter per provider ([src/collect/parsers.js](src/collect/parsers.js)): a function from log lines to usage events, plus an account reader in [src/discover.js](src/discover.js). PRs welcome.

## License

MIT
