# Dashboard through Cloudflare (owner guide)

The shared dashboard lives at one address, e.g. `https://usage.example.com`, behind a login. It works from any browser or phone, with no Tailscale needed, whenever **at least one** plainsight machine that holds the tunnel token is on.

This guide is for the pool owner. You do it once. Boxes only need the [tunnel token](#adding-machines-to-the-tunnel).

Contents:
[How it works](#how-it-works) ·
[Prerequisites](#prerequisites) ·
[API token](#cloudflare-api-token) ·
[Setup](#setup) ·
[Google sign-in](#google-sign-in) ·
[Adding machines](#adding-machines-to-the-tunnel) ·
[Who can sign in](#who-can-sign-in) ·
[Costs](#costs-and-free-limits) ·
[Security](#security) ·
[Troubleshooting](#troubleshooting) ·
[Teardown](#teardown-and-undo)

---

## How it works

```
 phone / browser
      │ https://usage.example.com
      ▼
 Cloudflare Access ── login: emailed code and/or Google; only allowed emails get through
      │
      ▼
 Worker "plainsight-gate" ── only on the page itself (/ and /index.html):
      │                       shows "No machine is online" when nothing answers
      ▼
 Tunnel "plainsight" ── Cloudflare sends each visitor to any connector that is up
      │            │            │
      ▼            ▼            ▼
  your computer   box A        box B        cloudflared on each machine (outbound connection only)
      │            │            │
      ▼            ▼            ▼
 127.0.0.1:4749 (read-only view of that machine's full copy of the data)
```

- **Connectors (replicas).** Every machine that has the tunnel token runs `cloudflared`, started and supervised by the plainsight daemon. Each one connects *out* to Cloudflare. No ports are opened on any machine, and no machine needs a public IP.
- **Any machine can answer.** Every machine holds a full copy of the pool's data, so it does not matter which connector serves a visit. The page footer says which machine served it.
- **Only after the first sync.** A machine joins the tunnel only after its first successful sync with a peer (or immediately when it has no peer to sync with). Visitors never land on a half-empty copy.
- **Read-only.** The connector forwards to `127.0.0.1:4749`, a separate listener that answers only `GET` and `HEAD` (anything else gets `405`). The full local dashboard with its control endpoints (`announce`, `stop`, colours) stays on `127.0.0.1:4748` and is never published.
- **Offline page.** When no connector is up (Cloudflare error 530 / 1033), or a connector cannot reach plainsight (502, 503, 504), the Worker shows a black "No machine is online" page that retries every 20 seconds. Access runs before the Worker, so only signed-in, allowed visitors see even that.

Tailscale is not involved in any of this. It only carries usage sync between machines ([TAILNET.md](TAILNET.md)).

---

## Prerequisites

| What | Notes |
|---|---|
| A Cloudflare account | Free plan is enough |
| A domain whose DNS is on Cloudflare | The zone must be active on Cloudflare (nameservers pointed at Cloudflare). You use one hostname in it, e.g. `usage.example.com` |
| Zero Trust enabled on the account | Once: open [one.dash.cloudflare.com](https://one.dash.cloudflare.com), pick a **team name** and the **Free** plan. It may ask for a payment card; nothing is charged unless you choose a paid plan. The team name gives your login domain, `https://<team>.cloudflareaccess.com` |
| plainsight installed and initialised on the machine you run setup from | Usually your own computer (`plainsight init` + `plainsight install`). Setup saves its ids in this machine's `config.json` and this machine becomes the first connector |

**Hostname choice.** Pick a name one level below your domain (`usage.example.com`, not `a.b.example.com`). Cloudflare's free Universal SSL certificate covers only one level of subdomain. Setup **replaces** any existing `A`, `AAAA` or `CNAME` record on that exact name; it stops if the name has any other record type (TXT, MX, …).

---

## Cloudflare API token

plainsight talks to the [Cloudflare API](https://developers.cloudflare.com/api/) with a token you create. It reads it from `--token-file FILE` or the `CLOUDFLARE_API_TOKEN` environment variable, uses it only while the command runs and **never stores it**. Never pass the token itself as an argument.

Create it: [dash.cloudflare.com](https://dash.cloudflare.com) → My Profile → API Tokens → *Create Token* → *Create Custom Token*.

**For `cloudflare setup`, `cloudflare teardown` and `cloudflare tunnel-token`:**

| Scope | Permission | Level |
|---|---|---|
| Account | Cloudflare Tunnel | Edit |
| Account | Access: Apps and Policies | Edit |
| Account | Access: Organizations, Identity Providers, and Groups | Edit |
| Account | Workers Scripts | Edit |
| Zone | Workers Routes | Edit |
| Zone | DNS | Edit |
| User | User Details | Read (optional: lets setup default to your Cloudflare email when you pass no `--email`) |

**For day-to-day `access` commands and `cloudflare status`, a smaller token is enough:**

| Scope | Permission | Level |
|---|---|---|
| Account | Access: Apps and Policies | Edit |
| Account | Access: Organizations, Identity Providers, and Groups | Edit |
| Account | Cloudflare Tunnel | Read (every `access` command and `cloudflare status` read the tunnel's connections) |

Then:
- **Account Resources:** Include → your account.
- **Zone Resources:** Include → Specific zone → your domain.
- **TTL:** set an end date a few days out.

Save it to a private file:

```sh
# paste the token into the file with an editor, then
chmod 600 ~/.plainsight/cf-token
```

Create a token when you need one and revoke it afterwards (My Profile → API Tokens → ⋯ → *Delete*). Nothing in plainsight keeps working off it.

---

## Setup

On the machine you initialised (below, `plainsight` means `node ~/.plainsight/app/bin/plainsight.js`):

```sh
plainsight cloudflare setup --hostname usage.example.com --token-file ~/.plainsight/cf-token \
  --email you@example.com,friend@example.com
```

| Option | Meaning |
|---|---|
| `--hostname H` | Required the first time. The dashboard address |
| `--email E[,E..]` | Who may sign in, comma-separated. Without `--email` and `--domain`, setup allows the Cloudflare account's own email (needs *User Details: Read*) |
| `--domain D` | Allow every address `@D`, e.g. your company domain. Comma-separated for several |
| `--session 720h` | How long a sign-in lasts (default `720h`, 30 days) |
| `--google-client-id ID --google-secret-file F` | Turn on "Sign in with Google" now ([Google sign-in](#google-sign-in)). You can also do it later with `plainsight access google` |
| `--account ID` | Needed only when the token can see more than one Cloudflare account |
| `--token-file F` | The API token file (or set `CLOUDFLARE_API_TOKEN`) |

What it does, in order:

| Step | Result |
|---|---|
| Tunnel | Creates the remotely managed tunnel `plainsight`. Ingress: `H → http://127.0.0.1:4749` (this machine's `viewPort`), everything else → 404 |
| Tunnel token | Saves it to `~/.plainsight/tunnel-token` (mode 600). Never printed |
| Identity providers | Ensures the "Email code" (one-time PIN) provider. Adds or updates Google if you passed it |
| Access policy | Reusable policy `plainsight viewers`: allow the emails and email domains you gave |
| Access app | Self-hosted app `plainsight` on `H`, with that policy, your sign-in options and session length. Not shown in the App Launcher. With a single sign-in option, the login page skips straight to it |
| Worker | Uploads `plainsight-gate` ([web/gate-worker.js](../web/gate-worker.js)) and routes it on `H/` and `H/index.html` only |
| DNS | Replaces the hostname's `A`/`AAAA`/`CNAME` records with one proxied `CNAME` to `<tunnel-id>.cfargotunnel.com` |
| Login page | Styled black with "plainsight" as header, **only** if the account has no other Access apps (the login design is account-wide) |
| Config | Saves only non-secret ids under `"cloudflare"` in this machine's `config.json`, then restarts the daemon |

The daemon then starts `cloudflared` (after its first sync) and the dashboard is live at `https://H`. Check with:

```sh
plainsight cloudflare status --token-file ~/.plainsight/cf-token
```

It prints the URL, the sign-in options, the session length, who is allowed and every connected connector.

**Re-running setup** is safe: it updates what exists and never creates duplicates. Options you leave out keep their current values: who may sign in, the sign-in options and the session length stay as they are. On the very first run, without `--email`/`--domain`, it allows your Cloudflare account's email. For day-to-day changes, use the [`access` commands](#who-can-sign-in).

**Where the ids live.** `cloudflare status|tunnel-token|teardown` and all `access` commands read the `"cloudflare"` block of `config.json`. Run them on the machine that ran setup, or copy that block into another machine's `config.json`.

---

## Google sign-in

Optional. Without it, people sign in with a code Cloudflare emails them. With it, the login page also offers "Sign in with Google". You need your login domain, `<team>.cloudflareaccess.com` (setup prints the redirect URI when Google is not configured yet).

In the [Google Cloud Console](https://console.cloud.google.com):

1. **Project.** Top bar project picker → *New project* → any name (e.g. `plainsight-login`) → *Create*, then select it.
2. **Branding.** Menu → *Google Auth Platform* → *Branding* (on first use: *Get started*). App name: `plainsight`. User support email and developer contact: your address. Save.
3. **Audience.** *Google Auth Platform* → *Audience*. User type: **External**. Publishing status: leave it in **Testing**. Under *Test users* → *Add users* → add your own address and everyone else who should use Google sign-in (up to 100). For personal use, your own address is enough.
4. **Client.** *Google Auth Platform* → *Clients* → *Create client*.
   - Application type: **Web application**. Name: `Cloudflare Access`.
   - Authorized JavaScript origins: `https://<team>.cloudflareaccess.com`
   - Authorized redirect URIs: `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
   - *Create*. Copy the **Client ID**. Save the **Client secret** to a private file, e.g. `~/.plainsight/google-secret` (`chmod 600`).
5. On your machine:
   ```sh
   plainsight access google --client-id 1234-abc.apps.googleusercontent.com \
     --client-secret-file ~/.plainsight/google-secret --token-file ~/.plainsight/cf-token
   rm ~/.plainsight/google-secret
   ```
   This adds (or replaces) the Google identity provider in Cloudflare and turns on "Google or emailed code". The secret is stored in Cloudflare only, never by plainsight.
6. Optional: `plainsight access login google` for Google only (the login page then goes straight to Google), or `login code` / `login both`.

Google sign-in still requires the address to be on the allowed list. Testing mode only limits *who can use Google*; people who are allowed but not Google test users can still use the emailed code.

---

## Adding machines to the tunnel

Your computer has the tunnel token from setup. Give it to every box that should be able to show the dashboard; then the dashboard stays up while any of them is on.

On the machine that ran setup:

```sh
plainsight cloudflare tunnel-token --out ~/ps-tunnel-token --token-file ~/.plainsight/cf-token
```

It writes the token to the file (mode 600; default `~/.plainsight/tunnel-token.for-box`) and never prints it. Copy the file to the box privately (scp, a password manager, …), then on the box:

```sh
plainsight tunnel join --token-file ~/ps-tunnel-token
rm ~/ps-tunnel-token
```

`tunnel join` stores the token at `~/.plainsight/tunnel-token` (mode 600) and restarts the daemon. The daemon starts `cloudflared` after its first successful sync. Check:

```sh
plainsight tunnel status     # configured, running, pid, restarts, last error, synced
plainsight doctor            # "dashboard tunnel connector running"
```

On the owner's machine, `plainsight cloudflare status` lists one connector per machine.

**cloudflared.** The daemon uses, in order: the path in config key `"cloudflared"`, `cloudflared` on `PATH`, or `~/.plainsight/bin/cloudflared` (downloaded once from the [latest GitHub release](https://github.com/cloudflare/cloudflared/releases) when nothing else is found). It runs `cloudflared tunnel --no-autoupdate run` with the token in the environment (`TUNNEL_TOKEN`), never on the command line, logs to `~/.plainsight/cloudflared.log` and restarts it with backoff (5 s doubling up to 5 min) if it exits. If you prefer a packaged build, install `cloudflared` yourself and it is picked up from `PATH`.

**Same view port everywhere.** The tunnel's ingress points every connector at `http://127.0.0.1:<viewPort>` of the machine that ran setup (default 4749). Keep `viewPort` the same on every machine.

### Removing a machine

- On the machine: `plainsight tunnel leave`. It deletes the token and restarts the daemon without `cloudflared`. The machine keeps sharing usage.
- `plainsight stop` (or shutting the machine down) also stops its connector, until the daemon starts again.
- A machine you no longer control keeps a valid token. Tunnel tokens are per tunnel, not per machine, so the only way to cut it off is a new tunnel: `plainsight cloudflare teardown --yes`, then `cloudflare setup` again with your options, then hand the new token to the machines you keep.

---

## Who can sign in

All of these need the API token (`--token-file F` or `CLOUDFLARE_API_TOKEN`) and apply within seconds.

| Command | Effect |
|---|---|
| `access list` | Allowed emails and email domains |
| `access add EMAIL [EMAIL..]` | Allow these addresses |
| `access remove EMAIL [EMAIL..]` | Disallow them and sign them out everywhere now. Refuses to leave nobody allowed |
| `access allow-domain DOMAIN` | Allow every address `@DOMAIN` |
| `access remove-domain DOMAIN` | Stop allowing that domain. Refuses to leave nobody allowed |
| `access login google\|code\|both` | Which sign-in options the login page offers. `google` needs Google configured |
| `access google --client-id ID --client-secret-file F` | Add or replace "Sign in with Google"; turns on `both` |
| `access session DURATION` | How long a sign-in lasts: minutes `m` or hours `h`, e.g. `24h`, `168h`, `720h` |
| `access revoke [EMAIL]` | Sign out one person (from all Access apps in the account), or, with no email, everyone on this app |

Everyone allowed signs in with their own email address. Nobody needs a Cloudflare account. Removing someone from the list does not touch Cloudflare or Google accounts; they simply cannot get in any more.

---

## Costs and free limits

| Piece | Plan | Limit that matters |
|---|---|---|
| Cloudflare Zero Trust (Access) | Free | 50 users (each person who signs in counts as one) |
| Cloudflare Tunnel | Free | Not metered |
| DNS | Free | None |
| Worker `plainsight-gate` | Workers Free | 100,000 requests/day. Only page loads go through it (`/` and `/index.html`); the dashboard's data calls go straight to the tunnel, so one visit is about one request |
| Google OAuth client | Free | Testing mode: up to 100 test users |

If the Worker's daily limit is ever exceeded on the free plan, nothing is billed. The route steps aside for the rest of the day and the dashboard still loads; you only lose the friendly offline page until the limit resets.

---

## Security

- **Login first.** Every request to the hostname goes through Cloudflare Access before anything else. Only addresses on the allowed list get through.
- **Read-only.** What the tunnel reaches (`127.0.0.1:4749`) can only read: `GET`/`HEAD` of the page, `/api/summary`, `/api/live`, and a minimal `/api/health` (version and nickname only; no IPs, peers or paths). Writes get `405`. Control endpoints exist only on `127.0.0.1:4748`, which is never published. Colour changes made through the public URL are saved in that browser only.
- **No inbound ports.** `cloudflared` only dials out. Machines need no public IP and no firewall change.
- **What Cloudflare sees.** TLS ends at Cloudflare, so Cloudflare can see the dashboard's contents: usage numbers, machine nicknames, operator names, subscription labels and announcements. Never prompts, code or paths; those never leave the machine that wrote them.
- **The tunnel token** can run connectors for this one tunnel and nothing else in your Cloudflare account. Anyone holding it could add a connector and answer some of your visitors' requests, so give it only to machines you already trust in the pool. Keep it in its file (mode 600); plainsight never prints it or puts it on a command line.
- **The API token and the Google client secret** are never stored by plainsight. The Google secret lives in Cloudflare.

---

## Troubleshooting

Start with `plainsight doctor` on the machines, and `plainsight cloudflare status` on the owner's machine.

| Symptom | Cause | Fix |
|---|---|---|
| Black "No machine is online" page | No connector is up | `cloudflare status` shows `machines connected: 0`. Start a machine, or check `plainsight doctor` on one |
| `doctor`: `dashboard tunnel not running (waiting for the first sync)` | The machine has peers but has not synced with any yet | Fix sync first (`plainsight status`, [TROUBLESHOOTING.md](TROUBLESHOOTING.md)). It joins after the first successful sync |
| `doctor`: `not in the dashboard tunnel` | No tunnel token on this machine | `plainsight tunnel join --token-file F` |
| `doctor`: `dashboard tunnel not running: cloudflared exited (...)` | cloudflared failed (bad or old token, no internet) | Read `~/.plainsight/cloudflared.log`. After a teardown/setup, re-run `tunnel join` with the new token |
| `download cloudflared-...: HTTP ...` or `no cloudflared build for ...` in `daemon.log` | GitHub unreachable, or an unsupported platform | Install `cloudflared` yourself (it is used from `PATH`), or set `"cloudflared": "/full/path"` in `config.json`, then `plainsight restart` |
| `view port 4749 unavailable` in `daemon.log`; visitors get the offline page or 502 | Something else uses port 4749 on that machine | Free the port, or set the same `viewPort` on every machine and re-run `cloudflare setup` so the tunnel points at it |
| Cloudflare's own error page (530 / 1033) instead of the offline page | The Worker only covers the page itself; a data call or other path hit an empty tunnel. Or the Worker's daily limit was exceeded | Reload once a machine is up |
| Login keeps asking again, or "That account does not have access" | The address is not on the allowed list, or the browser blocks cookies for the hostname or `<team>.cloudflareaccess.com` | `plainsight access list`, `access add EMAIL`; try a private window; `access revoke EMAIL` to clear a stuck session |
| No emailed code arrives | Spam folder, or the address is not allowed (Cloudflare only sends codes to allowed addresses) | Check spam; `access add EMAIL` |
| Google: `redirect_uri_mismatch` | Redirect URI in the Google client is wrong | It must be exactly `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` |
| Google: "Access blocked" / app not verified | The address is not a test user | Google Auth Platform → Audience → *Test users* → add it |
| `Cloudflare Zero Trust is not set up on this account yet` | Zero Trust never enabled | Open [one.dash.cloudflare.com](https://one.dash.cloudflare.com), pick a team name and the Free plan, re-run |
| `token sees N accounts; pass --account ID` | The token covers several accounts | Pass `--account` with the id it lists |
| `no Cloudflare zone for H is visible to this token` | Domain not on Cloudflare, or the token's Zone Resources exclude it | Add the zone to the token |
| `H has a TXT record; remove it first` (or MX, …) | Another record type sits on the hostname | Move it, or pick another hostname |
| `HTTP 403 ... Authentication error` / `10000` | The token lacks a permission | Compare with [the permission table](#cloudflare-api-token) |
| `pass --email you@example.com` | No `--email` and the token cannot read your user email | Pass `--email`, or add *User Details: Read* |
| `run plainsight cloudflare setup first` | This machine's `config.json` has no `"cloudflare"` block (you are on a different machine than the one that ran setup) | Run on the machine that ran setup, copy the block over, or re-run `cloudflare setup --hostname H` with your options |
| Browser certificate error | Hostname two levels deep (`a.b.example.com`) | Use a first-level subdomain, or buy an advanced certificate in Cloudflare |
| Two loads show slightly different numbers | They were served by different machines, a few seconds apart in sync | Normal; copies converge within about a minute. The footer shows which machine served the page |

`~/.plainsight/cloudflared.log` keeps cloudflared's own output; it is started fresh when it passes 5 MB.

---

## Teardown and undo

```sh
plainsight cloudflare teardown --yes --token-file ~/.plainsight/cf-token
```

Removes, in order: the Worker routes, the Worker `plainsight-gate`, the Access app, the policy `plainsight viewers`, the hostname's tunnel `CNAME` and the tunnel itself. It deletes the local tunnel token and the `"cloudflare"` block from `config.json`. Each step reports its own result, so a step that fails does not stop the rest.

It keeps:
- the identity providers (Email code, Google), which other Access apps may use. Delete them in Zero Trust → Settings → Authentication if you want.
- Zero Trust itself and your team name.
- the Google OAuth client. Delete it in the Google Cloud Console if you want.

Then run `plainsight tunnel leave` on every box to delete their (now useless) tokens. Machines keep sharing usage over Tailscale either way; each still has its local dashboard at `http://127.0.0.1:4748`.

To start over, run `cloudflare setup` again. It creates a new tunnel with a new token, so hand the new token to the boxes.
