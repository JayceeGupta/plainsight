---
name: plainsight
description: Shared AI-usage awareness across the machines in a plainsight pool. Use before starting long, overnight or heavy work (announce it), when asked who is using a Claude/Codex subscription right now, or how much was used in a time window (5h, 24h, 7d…), per machine or per subscription.
---

# plainsight (runtime)

Machines in this pool share one or more Claude Code and Codex subscriptions. plainsight shows everyone the usage numbers. It never shows prompts or code. Use the `plainsight` MCP tools.

## When to use it

- **Before heavy work, announce it.** Call `announce` with a short message and duration before you start anything that will burn a lot of the shared limit:
  - an overnight or multi-hour autonomous run
  - large refactors
  - many parallel subagents
  - big test or eval sweeps

  Example: `announce({ message: "Overnight migration of payments service, many subagents", hours: 8, heavy: true })`. Every machine's dashboard shows a banner, so others expect the 5-hour limit to run out.
- **Before starting heavy work, check `live`.** If another machine is mid-heavy-run on the same subscription, tell the human: the limit may already be close.
- **When asked about usage**, call `usage` with a `range` (`1h`, `5h`, `24h`, `7d`, `30d`, `90d`) and optional `subscription`, `machine` or `provider` filters. Each subscription is reported separately; never add numbers from different subscriptions together in your answer.
- **When asked which machines exist or are online**, call `machines`.

## Notes

- Costs are API-equivalent estimates from public model prices. Subscriptions are flat-rate, so treat cost as "value used", not money spent.
- Rate-limit percentages are not tracked. Check `/usage` in Claude Code or the Codex status line on a machine if you need the exact remaining limit.
- Keep announcement messages free of secrets, file contents and customer data. Other machines in the pool see them.
- CLI equivalents: `plainsight announce "msg" --hours 8`, `plainsight status`, `plainsight url`.
