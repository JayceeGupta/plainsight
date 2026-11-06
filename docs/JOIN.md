# Joining a machine by hand

The agent skill ([skills/plainsight-setup/SKILL.md](../skills/plainsight-setup/SKILL.md)) automates all of this. These are the same steps for people.

You need:
- the pool's **auth key**, from the pool owner (see [TAILNET.md](TAILNET.md)), in a private file, e.g. `~/ps-key`
- Node 18.17+, git, and Claude Code and/or Codex logged in

## 1. Install Tailscale

| OS | Command |
|---|---|
| Debian/Ubuntu/Fedora/… | `curl -fsSL https://tailscale.com/install.sh \| sh` |
| macOS | `brew install --cask tailscale` (open the app once), or headless: `brew install tailscale && sudo brew services start tailscale` |
| Windows | `winget install Tailscale.Tailscale` |
| Container without `/dev/net/tun` | `tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:1055 --state=mem: &` and later set `PLAINSIGHT_SOCKS=127.0.0.1:1055` |

## 2. Join the pool as a tagged box

Pick a nickname everyone will recognise (`gpu-1`, `ci-runner-3`, `alex-mbp`).

```sh
# Linux. --operator lets plainsight run `tailscale serve` without sudo.
sudo tailscale up --auth-key="$(cat ~/ps-key)" --advertise-tags=tag:plainsight --hostname=ps-gpu-1 --operator=$USER
# macOS / Windows (admin terminal)
tailscale up --auth-key="$(cat ~/ps-key)" --advertise-tags=tag:plainsight --hostname=ps-gpu-1
rm ~/ps-key
```

- Already logged into Tailscale as someone else? Add `--force-reauth`. This disconnects the old identity.
- Check: `tailscale status --self --json` → `Self.Tags` includes `tag:plainsight`.

## 3. Install plainsight

```sh
git clone https://github.com/JayceeGupta/plainsight ~/.plainsight/app
alias plainsight="node ~/.plainsight/app/bin/plainsight.js"
plainsight discover
```

`discover` shows each Claude Code / Codex install with its account, subscription id, start date and how much history it has. Decide which to track and what to call each subscription. Use the same label as other machines on the same account.

```sh
plainsight init --nick gpu-1 --operator alex \
  --track "claude|/home/alex/.claude|Max (team)|2026-03-29" \
  --track "codex|/home/alex/.codex|Codex (team)"
plainsight install
plainsight doctor
```

- `SINCE` (the 4th field) applies to Claude only. History before that date is ignored. Use it when the install was logged into another account earlier.
- Restart Claude Code / Codex sessions so they load the MCP server and skill.

## 4. Check it worked

- `plainsight status`: daemon running, peers listed, `sync <peer>: ok`.
- Open `http://127.0.0.1:4748`: the machine appears under **Machines**, with its history.
- On another machine, the new machine appears within a minute.

## Personal device (untagged)

Your own laptop, already on the tailnet as you:

1. The pool owner adds its Tailscale IP as `plainsight-admin` in the policy ([TAILNET.md](TAILNET.md#admin-device)).
2. Do steps 3–4 above. Skip step 2: don't tag it.
3. It does not host the dashboard service. It syncs by dialing out to boxes.
