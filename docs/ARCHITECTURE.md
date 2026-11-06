# Architecture and protocol

## Components (one Node process, no dependencies)

| File | Role |
|---|---|
| `src/discover.js` | Finds Claude Code / Codex installs and their logged-in account. Derives subscription ids |
| `src/collect/parsers.js` | Pure functions: provider log lines → usage events |
| `src/collect/index.js` | Tails tracked logs from saved byte offsets. Enforces account and `since` rules. Dedupes |
| `src/store.js` | Append-only logs, one per origin. Validation. Version vector |
| `src/sync.js` | Peer discovery via `tailscale status`, the gossip exchange, optional SOCKS5 |
| `src/daemon.js` | Collector loop, sync loop, sync server, dashboard server, SSE, Tailscale Service hosting |
| `src/aggregate.js` | Events → per-subscription totals, series, live sessions, machines |
| `src/prices.js` | LiteLLM price table, cached, with local overrides |
| `src/mcp.js` | MCP server over stdio |
| `src/install.js` | Service install (systemd user unit / launchd agent / Windows Startup-folder launcher), Claude/Codex integration |
| `src/pool.js` | Tailnet bootstrap via the Tailscale API |
| `web/index.html` | Dashboard (single file, no build) |

## Data model

Each machine has a random `nodeId` (origin). It is the **only writer** of `log/<nodeId>.jsonl`. Every line is one event:

```json
{"o":"43c6701919bb3cc6","s":1234,"t":1762434000000,"k":"u","p":"claude","sub":"d52715f0ab9db137","sid":"9f2c1a0b44e1","m":"claude-opus-5-5","in":12,"cr":180000,"cw":2400,"out":950,"id":"5be0…","bf":1}
```

| Field | Meaning |
|---|---|
| `o` | Origin (machine id) |
| `s` | Sequence number within the origin, 1-based and contiguous |
| `t` | Epoch ms |
| `k` | Kind (table below) |

| Kind | Fields | Meaning |
|---|---|---|
| `hello` | `nick host os op ver` | Identity; latest wins |
| `sub` | `sub p label` | Subscription label; latest wins pool-wide |
| `u` | `p sub sid m in cr cw out rs id bf?` | One API response's usage. `in` = uncached input. `rs` = reasoning tokens, already included in `out` for Codex |
| `hb` | none | Heartbeat every 2 min |
| `ann` | `msg heavy hours until` | Heavy-work announcement |
| `bye` | none | Clean shutdown |

**Online** = last event less than 5 minutes ago and not `bye`. **Live session** = a `(machine, subscription, session)` with usage in the last 10 minutes. Its "running" time is the current stretch of activity; a pause of more than 30 minutes restarts it.

## Collection rules

- **Claude Code.**
  - Reads `type: "assistant"` lines with `message.usage`. One message can be logged several times (once per content block), always with the same usage, so it is deduped by `message.id + requestId`.
  - Skips `<synthetic>` models.
  - Account guard: after install, a line is accepted only while the install's `oauthAccount.accountUuid` matches the tracked subscription. History before install uses the `since` date.
- **Codex.**
  - Prefers `token_usage_record` (one per response, deduped by `response_id`).
  - Falls back to deltas of `event_msg/token_count.total_token_usage` for older logs.
  - Model comes from `turn_context.model`. Account comes from `session_meta.creator_account_id`, per session.
  - `in` = `input_tokens − cached_input_tokens`.
- **Offsets.** Per-file offsets live in `state.json`. A file that shrinks is re-read from 0; dedup ids prevent double counting. Only complete lines are read.

## Sync protocol (HTTP/JSON over Tailscale, port 4747)

```
A → B   GET  /sync/vv                         ← {protocol, version, vv: {origin: count}}
A → B   POST /sync/exchange {have: vvA, give: {origin: {from, lines[]}}}
                                              ← {give: {origin: {from, lines[]}}}  (what A lacks)
```

- **Batches.** At most 5,000 lines per origin per message; the exchange repeats until nothing is left.
- **Ingest.** Accepts the longest valid contiguous prefix. Overlaps are skipped, gaps are refused (the next round resends from the right offset). A peer can never write the receiver's own origin.
- **Validation.** Kind, sizes, numeric ranges, time in `[2017, now + 1 day]`, `o`, and `s` must equal the expected next sequence.
- **Triggers.** Every 60 s, and 2 s after local events. Peers = online devices tagged `tag:plainsight` (`tailscale status --json`).
- **Untagged devices** run no sync server. They only dial out, so boxes never need to reach them.
- **Convergence.** Each origin's log is a grow-only sequence with one writer, so state is a union of per-origin prefixes. Any exchange order converges; there is no consensus, no leader and no quorum.

## Serving

- **Dashboard and read API:** `127.0.0.1:4748`.
  - `GET /` → dashboard
  - `GET /api/summary?range&subs&machines&providers&tz` → aggregates
  - `GET /api/live` → SSE (`event: change`)
  - `GET /api/health` → status
- **Control endpoints:** `POST /api/announce`, `/api/stop`, `/api/poke`. They require a direct localhost request (Host `127.0.0.1`/`localhost`, no `Tailscale-User-Login` or `X-Forwarded-For`).
- **Tailscale Service.** On tagged boxes: `tailscale serve --service=svc:plainsight --https=443 127.0.0.1:4748` and `--http=80`. Every box hosts the same data, so any of them can answer.

## MCP

- **Transport.** stdio, newline-delimited JSON-RPC. Supports `initialize`, `ping`, `tools/list`, `tools/call`.
- **Version.** Protocol `2025-11-25`, negotiating down to `2024-11-05`.
- **Data.** Reads logs read-only from disk. `announce` posts to the local daemon.

## Failure modes

| Situation | Behaviour |
|---|---|
| Machine offline | Its events are already on peers; it catches up when it returns |
| All boxes offline | The dashboard service is down; each machine's local dashboard still works |
| Daemon crash mid-write | A partial last line is truncated on next start |
| Clock skew | Events keep the writer's timestamp; online detection uses each origin's own clock |
| Disk wiped on a box | It gets a new `nodeId` on re-init and re-backfills local history. Old events stay under the old origin, deduped by nothing, so don't re-init a box that still has its old logs (reuse `config.json` instead) |
| Two installs, same account | `init` refuses to track the same subscription twice on one machine |
