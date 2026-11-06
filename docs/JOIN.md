# Joining a machine by hand

The agent skill ([skills/plainsight-setup/SKILL.md](../skills/plainsight-setup/SKILL.md)) automates all of this. These are the same steps for people.

**A pool needs at least one box.** Only boxes (tagged `tag:plainsight`) accept sync connections. Personal (untagged) machines connect out to boxes and never to each other, so if every machine is a personal one, nothing is shared. Make at least one machine a box, ideally one that is always on.

You need:
- for a box: the pool's **Tailscale auth key**, from the pool owner ([TAILNET.md](TAILNET.md)), in a private file, e.g. `~/ps-key`
- optionally the **tunnel token**, from the pool owner ([DASHBOARD.md](DASHBOARD.md#adding-machines-to-the-tunnel)), in a private file, e.g. `~/ps-tunnel-token`, so this machine can also show the dashboard
- Node 20+, git, and Claude Code and/or Codex logged in

## 1. Install Tailscale

| OS | Command |
|---|---|
| Debian/Ubuntu/Fedora/… | `curl -fsSL https://tailscale.com/install.sh \| sh` |
| macOS | `brew install --cask tailscale` (open the app once), or headless: `brew install tailscale && sudo brew services start tailscale` |
| Windows | `winget install Tailscale.Tailscale` |
| Container without `/dev/net/tun` | `tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:1055 --state=mem: &` and later set `PLAINSIGHT_SOCKS=127.0.0.1:1055` |

Any recent Tailscale version works.

## 2. Join the pool as a tagged box

Skip this step on a personal device ([below](#personal-device-untagged)).

Pick a nickname everyone will recognise (`gpu-1`, `ci-runner-3`, `build-server`). `file:` makes `tailscale` read the key from the file, so it never appears in the command line or shell history.

```sh
# Linux
sudo tailscale up --auth-key=file:$HOME/ps-key --advertise-tags=tag:plainsight --hostname=ps-gpu-1
# macOS
tailscale up --auth-key=file:$HOME/ps-key --advertise-tags=tag:plainsight --hostname=ps-gpu-1
rm ~/ps-key
```

```powershell
# Windows (from an elevated terminal if it says access is denied)
tailscale up --auth-key=file:C:\Users\you\ps-key --advertise-tags=tag:plainsight --hostname=ps-gpu-1
Remove-Item C:\Users\you\ps-key
```

- The auth key is used once, here. The box does not need it afterwards. The default key is not ephemeral, so the box stays in the tailnet while it is off.
- Already logged into Tailscale as someone else? Add `--force-reauth`. This disconnects the old identity.
- Check: `tailscale status --self --json` → `Self.Tags` includes `tag:plainsight`.

## 3. Install plainsight

Clone, then run `discover` through node (the `plainsight` command exists only after `install`):

```sh
# macOS / Linux
git clone https://github.com/JayceeGupta/plainsight ~/.plainsight/app
node ~/.plainsight/app/bin/plainsight.js discover
```

```powershell
# Windows PowerShell
git clone https://github.com/JayceeGupta/plainsight "$env:USERPROFILE\.plainsight\app"
node "$env:USERPROFILE\.plainsight\app\bin\plainsight.js" discover
```

`discover` shows each Claude Code / Codex install with its account, subscription id, start date and how much history it has. Decide which to track and what to call each subscription. Use the same label as other machines on the same account.

```sh
# macOS / Linux
node ~/.plainsight/app/bin/plainsight.js init --nick gpu-1 --operator alex \
  --track "claude|/home/alex/.claude|Max (team)|2026-03-29" \
  --track "codex|/home/alex/.codex|Codex (team)"
node ~/.plainsight/app/bin/plainsight.js install
```

```powershell
# Windows PowerShell
$ps = "$env:USERPROFILE\.plainsight\app\bin\plainsight.js"
node $ps init --nick gpu-1 --operator alex `
  --track "claude|C:\Users\alex\.claude|Max (team)|2026-03-29" `
  --track "codex|C:\Users\alex\.codex|Codex (team)"
node $ps install
```

- Use the exact `DIR` that `discover` printed. `SINCE` (the 4th field) applies to Claude only. History before that date is ignored. Use it when the install was logged into another account earlier.
- Ports: `--port N` changes the sync port (default 4747; keep it the same everywhere, the tailnet policy allows only tcp:4747). `--web-port N` changes the local dashboard port (default 4748; the read-only view uses web port + 1).
- `install` adds the `plainsight` command: on macOS/Linux a symlink at `~/.local/bin/plainsight` (it prints a hint if `~/.local/bin` is not on your PATH); on Windows `%USERPROFILE%\.plainsight\bin\plainsight.cmd`, added to your user PATH. **Open a new terminal** to use it. From here on, just type `plainsight`.
- `install` also adds a Claude Code SessionStart hook (`plainsight ensure --quiet`), the MCP server and skill, and a background service: a systemd user unit (Linux), a LaunchAgent (macOS) or a Startup-folder launcher (Windows, no admin needed).
- Linux: if install warns that it could not enable lingering, the daemon stops when you log out. Fix: `sudo loginctl enable-linger $USER`.
- Restart Claude Code / Codex sessions so they load the MCP server and skill.

## 4. Join the dashboard tunnel (optional, recommended)

With the tunnel token from the owner, this machine also serves the dashboard at `https://<hostname>` while it is on:

```sh
plainsight tunnel join --token-file ~/ps-tunnel-token
rm ~/ps-tunnel-token
```

```powershell
plainsight tunnel join --token-file "$env:USERPROFILE\ps-tunnel-token"
Remove-Item "$env:USERPROFILE\ps-tunnel-token"
```

The token is stored at `~/.plainsight/tunnel-token` (mode 600). The daemon downloads `cloudflared` if it is not installed (verified against the SHA-256 in the GitHub release notes) and starts it after the first successful sync. Skip this step and the machine still shares its usage; it just never answers dashboard visitors.

## 5. Check it worked

```sh
plainsight doctor
plainsight status
plainsight tunnel status
```

- Daemon running, boxes listed, `sync <peer>: ok`.
- With step 4: `dashboard tunnel connector running`.
- Open `http://127.0.0.1:4748`: the machine appears under **Machines**, with its history.
- On another machine, or at `https://<hostname>`, the new machine appears within a minute.

## Personal device (untagged)

Your own computers, already on the tailnet as you. Any number of them can share:

1. Skip step 2: don't tag it. No policy change is needed; the pool policy lets every member device reach boxes on tcp:4747 ([TAILNET.md](TAILNET.md#personal-devices)).
2. Do step 3 above.
3. It syncs by connecting out to boxes; boxes never connect to it, and personal machines never connect to each other. With no box online it only has its own usage.
4. If it is the machine that ran `plainsight cloudflare setup`, it already has the tunnel token. Otherwise do step 4 if you want it to serve the dashboard too.
