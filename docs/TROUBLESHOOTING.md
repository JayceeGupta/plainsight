# Troubleshooting

Start with `plainsight doctor`; it prints a fix for each failed check. Logs: `~/.plainsight/daemon.log` (daemon) and `~/.plainsight/cloudflared.log` (dashboard tunnel connector). Problems with the public dashboard, login or Cloudflare setup: see [DASHBOARD.md](DASHBOARD.md#troubleshooting).

| Symptom | Cause | Fix |
|---|---|---|
| `daemon NOT running` | Not started, or crashed | `plainsight ensure`, then read `daemon.log` |
| `port 4748 in use: daemon already running` in the log | A second start attempt | Harmless |
| `tailscale not available` | CLI not in PATH (macOS app) or tailscaled down | `PLAINSIGHT_TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale`; `sudo systemctl start tailscaled` |
| Box shows `untagged` | Joined without `--advertise-tags` | `sudo tailscale up --advertise-tags=tag:plainsight --auth-key=… --force-reauth` |
| `sync <peer>: FAILED timeout` | Policy doesn't allow `tag:plainsight → tag:plainsight tcp:4747`, or the peer daemon is down | Check the policy ([TAILNET.md](TAILNET.md)); `plainsight status` on the peer |
| `peer protocol N, ours M` | Version mismatch | `plainsight update` on both |
| Personal device never syncs | Not in `plainsight-admin`, so boxes are unreachable | Add its IP to the policy's `hosts.plainsight-admin` |
| `dashboard tunnel not running (waiting for the first sync)` | The machine has peers but no sync has succeeded yet | Fix the sync error above; the connector starts by itself after the first good sync |
| `not in the dashboard tunnel` | No tunnel token on this machine | `plainsight tunnel join --token-file F` with the token from the owner ([DASHBOARD.md](DASHBOARD.md#adding-machines-to-the-tunnel)) |
| `dashboard tunnel not running: cloudflared exited` | Old or invalid token, no internet, cloudflared crashed | Read `cloudflared.log`; get a fresh token (`cloudflare tunnel-token` on the owner machine) and `tunnel join` again |
| `https://<hostname>` shows "No machine is online" | No machine with the tunnel token is connected | Start one; `plainsight doctor` on it |
| `could not remove tailscale serve ...` in the log | Upgrade from 0.1 on Linux without Tailscale operator rights | Run the `tailscale serve ... off` / `clear` command from the log line once with `sudo` |
| `logged into a DIFFERENT account` | Install switched accounts | Usage from the other account is skipped by design. Switch back, or `init` with what you want tracked |
| Claude history missing before ~30 days ago | Claude Code deleted it (`cleanupPeriodDays` default 30) | Can't be recovered. `install` raises it to 3650 from now on |
| Model shows **Unpriced** | Not in the LiteLLM table yet | Add it to `~/.plainsight/prices.json` |
| Two cards for one machine | It was re-initialised with a new `nodeId` but the same nickname | They are merged by nickname in the UI; harmless |
| Container: sync fails, `tailscale status` works | Userspace networking; outbound needs the SOCKS proxy | Start tailscaled with `--socks5-server=127.0.0.1:1055` and set `PLAINSIGHT_SOCKS=127.0.0.1:1055` |
| Windows: no background daemon after reboot | Startup launcher missing | `plainsight install` again; it writes `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\plainsight.vbs` |

Reset a machine completely:

```sh
plainsight uninstall --purge
```

This deletes local data. History it shared stays on other machines under its old id.
