# Troubleshooting

Start with `plainsight doctor`; it prints a fix for each failed check and keeps checking the rest when Tailscale is down. Logs: `~/.plainsight/daemon.log` (daemon) and `~/.plainsight/cloudflared.log` (dashboard tunnel connector). Problems with the public dashboard, login or Cloudflare setup: see [DASHBOARD.md](DASHBOARD.md#troubleshooting).

| Symptom | Cause | Fix |
|---|---|---|
| `plainsight: command not found` / not recognized | Not installed yet, a terminal opened before install (Windows), or `~/.local/bin` not on PATH (macOS/Linux) | Open a new terminal. macOS/Linux: add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile. Meanwhile: `node ~/.plainsight/app/bin/plainsight.js …` (Windows: `node "$env:USERPROFILE\.plainsight\app\bin\plainsight.js" …`) |
| Windows: `node ~/.plainsight/...` says the module cannot be found | PowerShell and cmd do not expand `~` for node | Use `"$env:USERPROFILE\.plainsight\app\bin\plainsight.js"`, or the `plainsight` command after install |
| `daemon NOT running` | Not started, or crashed | `plainsight ensure`, then read `daemon.log` |
| `daemon already running on port 4748` in the log | A second start attempt | Harmless |
| `port 4748 is used by another program` in the log; the daemon exits | Another program has the local dashboard port | Free the port, or pick another: `plainsight init ... --web-port N` (same `--track` options as before), then `plainsight restart`. The read-only view moves to N + 1 unless `viewPort` is set; keep `viewPort` the same on every machine in the tunnel |
| `plainsight stop`, but the daemon comes back | An older version that bypassed systemd / launchd | `plainsight update`. `stop` now goes through `systemctl --user` / `launchctl` |
| Daemon stops when you log out (Linux) | Lingering is off (install warned about it) | `sudo loginctl enable-linger $USER` |
| `tailscale: ...` in `status`, `Tailscale unavailable: ...` on the tunnel line | CLI not in PATH (macOS app), tailscaled down, or not signed in | `PLAINSIGHT_TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale`; `sudo systemctl start tailscaled`; sign in. Sharing pauses until it works; the local dashboard keeps going |
| Box shows `untagged` | Joined without `--advertise-tags` | `sudo tailscale up --auth-key=file:KEYFILE --advertise-tags=tag:plainsight --force-reauth` |
| `INFO no box online right now` | No box exists, or all are off | At least one box is needed for any sharing ([JOIN.md](JOIN.md)). Personal machines never sync with each other |
| `sync <peer>: FAILED timeout` | Policy doesn't allow the sync port, or the peer daemon is down | Re-run `plainsight pool bootstrap` ([TAILNET.md](TAILNET.md)): boxes need `tag:plainsight → tag:plainsight tcp:4747`, personal devices `autogroup:member → tag:plainsight tcp:4747`; `plainsight status` on the peer |
| `peer protocol N, ours M` | Version mismatch | `plainsight update` on both |
| Personal device never syncs | Old policy that only let a `plainsight-admin` host reach boxes, or no box online | Re-run `plainsight pool bootstrap --token-file F --apply --force` ([TAILNET.md](TAILNET.md#upgrading-from-an-earlier-plainsight-policy)) |
| `pool bootstrap`: `Your policy uses N old-style "acls" rule(s)` | bootstrap never rewrites `acls`; nothing was changed | Merge the grants from [policy/policy.example.hujson](../policy/policy.example.hujson) by hand, or convert your `acls` to grants first |
| A box disappeared from the tailnet after being off | It joined with an ephemeral key | Mint a normal key (`plainsight pool key`, without `--ephemeral`) and rejoin it |
| `dashboard tunnel not running (waiting for the first sync)` | The machine has peers but no sync has succeeded yet | Fix the sync error above; the connector starts by itself after the first good sync |
| `not in the dashboard tunnel` | No tunnel token on this machine | `plainsight tunnel join --token-file F` with the token from the owner ([DASHBOARD.md](DASHBOARD.md#adding-machines-to-the-tunnel)) |
| `dashboard tunnel not running: cloudflared exited` | Old or invalid token, no internet, cloudflared crashed | Read `cloudflared.log`; get a fresh token (`cloudflare tunnel-token` on the owner machine) and `tunnel join` again |
| `SHA-256 mismatch` / `no published SHA-256` in the log | The cloudflared download could not be verified, so it is not used | Install `cloudflared` yourself; it is picked up from `PATH` |
| `https://<hostname>` shows "No machine is online" | No machine with the tunnel token is connected | Start one; `plainsight doctor` on it |
| `could not remove tailscale serve ...` in the log | Upgrade from 0.1 on Linux without Tailscale operator rights | Run the `tailscale serve ... off` / `clear` command from the log line once with `sudo` |
| `logged into a DIFFERENT account` | Install switched accounts | Usage from the other account is skipped by design. Switch back, or `init` with what you want tracked |
| Claude history missing before ~30 days ago | Claude Code deleted it (`cleanupPeriodDays` default 30) | Can't be recovered. `install` raises it to 3650 from now on |
| Model shows **Unpriced** | Not in the LiteLLM table yet | Add it to `~/.plainsight/prices.json` |
| Two cards for one machine | It was re-initialised with a new `nodeId` but the same nickname | They are merged by nickname in the UI; harmless |
| Container: sync fails, `tailscale status` works | Userspace networking; outbound needs the SOCKS proxy | Start tailscaled with `--socks5-server=127.0.0.1:1055` and set `PLAINSIGHT_SOCKS=127.0.0.1:1055` |
| Windows: no background daemon after reboot | Startup launcher missing | `plainsight install` again; it writes `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\plainsight.vbs` |

Remove plainsight from a machine:

```sh
plainsight uninstall           # service, hook, MCP, skill, command, tunnel token; keeps ~/.plainsight
plainsight uninstall --purge   # also deletes ~/.plainsight (code, usage copy, config, auth key, policy backups)
```

`--purge` deletes local data. History it shared stays on other machines under its old id. On the machine that ran `cloudflare setup`, `--purge` asks for `--yes`; run `plainsight cloudflare teardown --yes` first if you want the dashboard gone, because the purge deletes the ids teardown needs. A box also leaves the tailnet with `tailscale logout`.
