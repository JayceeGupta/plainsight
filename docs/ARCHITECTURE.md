# Architecture and protocol

## Components (one Node process, no dependencies)

| File | Role |
|---|---|
| `src/discover.js` | Finds Claude Code / Codex installs and their logged-in account. Derives subscription ids |
| `src/collect/parsers.js` | Pure functions: provider log lines → usage events |
| `src/collect/index.js` | Tails tracked logs from saved byte offsets. Enforces account and `since` rules. Dedupes |
| `src/store.js` | Append-only logs, one per origin. Validation. Version vector |
| `src/sync.js` | Peer discovery via `tailscale status`, the gossip exchange, optional SOCKS5 |
| `src/daemon.js` | Collector loop, sync loop, sync server, local dashboard and read-only view listeners, SSE, starts the tunnel connector, removes 0.1 `tailscale serve` entries |
| `src/tunnel.js` | Finds or downloads `cloudflared` and supervises the Cloudflare Tunnel connector |
| `src/cloudflare.js` | Owner-side Cloudflare setup through the Cloudflare API: tunnel, DNS, Access app and policy, identity providers, Worker |
| `src/aggregate.js` | Events → per-subscription totals, series, live sessions, machines |
| `src/prices.js` | LiteLLM price table, cached, with local overrides |
| `src/mcp.js` | MCP server over stdio |
| `src/install.js` | Service install (systemd user unit / launchd agent / Windows Startup-folder launcher), Claude/Codex integration |
| `src/pool.js` | Tailnet policy bootstrap and auth keys via the Tailscale API |
| `web/index.html` | Dashboard (single file, no build) |
| `web/gate-worker.js` | Cloudflare Worker `plainsight-gate`: the "No machine is online" page |

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

Every machine runs two HTTP listeners, both on 127.0.0.1 only:

| Listener | Port (config key) | Serves | Published |
|---|---|---|---|
| Local dashboard | `4748` (`webPort`) | The view below plus control endpoints | Never |
| Read-only view | `4749` (`viewPort`, default `webPort + 1`) | `GET`/`HEAD` only; anything else gets `405` | Through the Cloudflare Tunnel |

- **View (both listeners):**
  - `GET /` and `/index.html` → dashboard
  - `GET /api/summary?range&subs&machines&providers&tz` → aggregates
  - `GET /api/live` → SSE (`event: change`)
  - `GET /api/health` → status (version, peers, sync results, event counts, tracked subscriptions, tunnel state); on the tunnel-facing view listener only `{ok, version, nickname}`
- **Control endpoints (4748 only):** `POST /api/announce`, `/api/color`, `/api/stop`, `/api/poke`. They also require a direct localhost request (Host `127.0.0.1`/`localhost`, no `Tailscale-User-Login` or `X-Forwarded-For` header).
- If port 4749 is taken, the daemon logs `view port ... unavailable` and that machine does not join the tunnel.

### Dashboard tunnel

```
browser ─► Cloudflare Access (login) ─► Worker plainsight-gate (/ and /index.html only)
        ─► Tunnel "plainsight" ─► any connected cloudflared ─► 127.0.0.1:4749 on that machine
```

- **Connector.** If `~/.plainsight/tunnel-token` (or `tunnelTokenFile`) exists, the daemon runs `cloudflared tunnel --no-autoupdate run` with `TUNNEL_TOKEN` in its environment. Binary: config `cloudflared`, else `PATH`, else downloaded once from the latest GitHub release into `~/.plainsight/bin`. Output goes to `~/.plainsight/cloudflared.log`. On exit it is restarted after 5 s, doubling up to 5 min.
- **Join gate.** The connector starts only once the syncer is *ready*: a sync round reached at least one peer, or there were no peers to reach. Checked after the first round and then every 60 s.
- **Replicas.** All connectors belong to the same tunnel; Cloudflare sends each request to one that is connected. Every machine has the full data set, so any of them can answer. Requests from one visit may be answered by different machines.
- **Gate Worker.** On `/` and `/index.html` it passes the request through, and replaces a 502/503/504/530 response (or a failed fetch) with a 503 "No machine is online" page that reloads every 20 s. Other paths do not run through the Worker, which keeps usage at about one Worker request per visit.
- **Owner setup** is done by `src/cloudflare.js` through the Cloudflare API; every step is idempotent. Only non-secret ids are kept in `config.json` (`cloudflare.{accountId, zoneId, hostname, tunnelId, appId, policyId, authDomain, session}`).

### Cleanup of 0.1

plainsight 0.1 published the dashboard with `tailscale serve`. Once Tailscale is running, the daemon reads `tailscale serve status --json` once per start and turns off every HTTPS handler and TCP forward that points at `127.0.0.1`/`localhost` on its own `webPort` or `viewPort`, and clears `svc:plainsight` (or any service pointing at those ports). Other serve entries are left alone.

## MCP

- **Transport.** stdio, newline-delimited JSON-RPC. Supports `initialize`, `ping`, `tools/list`, `tools/call`.
- **Version.** Protocol `2025-11-25`, negotiating down to `2024-11-05`.
- **Data.** Reads logs read-only from disk. `announce` posts to the local daemon.

## Failure modes

| Situation | Behaviour |
|---|---|
| Machine offline | Its events are already on peers; it catches up when it returns |
| All tunnel machines offline | `https://<hostname>` shows the "No machine is online" page and retries every 20 s; each machine's local dashboard still works |
| One tunnel machine offline | Cloudflare sends visitors to the remaining connectors |
| Machine cannot sync yet | It does not join the tunnel until it has synced once, so it never serves a partial copy |
| Daemon crash mid-write | A partial last line is truncated on next start |
| Clock skew | Events keep the writer's timestamp; online detection uses each origin's own clock |
| Disk wiped on a box | It gets a new `nodeId` on re-init and re-backfills local history. Old events stay under the old origin, deduped by nothing, so don't re-init a box that still has its old logs (reuse `config.json` instead) |
| Two installs, same account | `init` refuses to track the same subscription twice on one machine |
