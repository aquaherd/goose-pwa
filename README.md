# goose-pwa

An iPhone-friendly PWA frontend for [goose](https://github.com/block/goose),
talking **ACP (Agent Client Protocol)** over WebSocket to `goose serve`,
served by **Caddy**. No build step, no Node, no dependencies — static files
plus two processes.

TLS is not this project's business: Caddy obtains a certificate from an
existing ACME CA (HomeCA on the Pi-hole) and renews it. The repo ships no
local CA, no self-signed certificate and no OCSP responder.

## Architecture

```
 iPhone (Safari / Home-Screen PWA)
    │  HTTPS (cert from HomeCA's step-ca) + WebSocket
    ▼
 Caddy (pihole) ──── static: /srv/goose-pwa
    │                 /acp, /status → 127.0.0.1:3284
    ▼
 goose serve        (ACP over HTTP/WebSocket, secret-key auth)
```

The browser speaks ACP (JSON-RPC 2.0) directly to goose's WebSocket endpoint
(`/acp`). Caddy only serves the app shell and reverse-proxies the socket.
There is no bridge process, and no certificate handling in this repo.

## Production: Pi-hole behind HomeCA

Everything needed is in `deploy/pihole/`. Assumptions (handled by the sibling
HomeCA project — step-ca on the Pi-hole — not by this repo):

- Caddy runs as a system service with `/etc/caddy/Caddyfile`.
- step-ca listens on `pihole.fritz.box:8443` with an ACME provisioner and its
  public endpoints behind `https://pihole.fritz.box`.
- HomeCA's root is installed at `/etc/caddy/homeca-root.crt`; devices that use
  the app trust it.

Deploy on the Pi-hole:

```sh
git clone https://github.com/aquaherd/goose-pwa
cd goose-pwa
sudo ./deploy/pihole/install.sh
```

The installer is idempotent and does six things:

1. copies `public/` to `/srv/goose-pwa`;
2. installs goose `1.55.0` (`GOOSE_VERSION=…` overrides) to
   `/usr/local/bin/goose` and enables the `goose-serve` systemd unit;
3. writes `/etc/goose-pwa/goose.env` with a fresh `GOOSE_SERVER__SECRET_KEY`
   (only if the file does not exist yet);
4. adds `192.168.188.3 goose.pihole.fritz.box` to Pi-hole's `dns.hosts` and
   reloads DNS;
5. installs `/etc/caddy/goose.caddy` and appends
   `import /etc/caddy/goose.caddy` to the main Caddyfile, validates it and
   reloads Caddy;
6. adds a log filter to the Caddyfile's global options so `?token=…` is
   stripped from error-log entries (Caddy logs the request URI when the ACP
   upstream fails, and the token travels as a query parameter).

Caddy answers the ACME HTTP-01 challenge on `:80` and requests the
certificate for `goose.pihole.fritz.box` from
`https://pihole.fritz.box:8443/acme/acme/directory`. Nothing needs to be
copied to the iPhone except HomeCA's root (see below).

Re-run `sudo ./deploy/pihole/install.sh` after a `git pull` to refresh the app
and the unit.

### Model provider on the Pi

`goose.env` is created with the secret key only. Either uncomment and fill in
the provider block there:

```sh
sudo nano /etc/goose-pwa/goose.env
# GOOSE_PROVIDER=opencode_go
# GOOSE_MODEL=deepseek-v4.1-flash
# OPENCODE_API_KEY=...
sudo systemctl restart goose-serve
```

or configure it interactively as the service user:
`sudo -iu goose goose configure`.

### Install on iPhone (Add to Home Screen)

1. Open `http://pihole.fritz.box/` in Safari, install HomeCA's root profile,
   then enable it under *Settings → General → About → Certificate Trust
   Settings* (once per device).
2. Open `https://goose.pihole.fritz.box`. The welcome screen asks for the
   secret key; paste the value of `GOOSE_SERVER__SECRET_KEY` from
   `/etc/goose-pwa/goose.env` (pasting the whole `KEY=value` line also works)
   and tap **Connect**. It is kept in localStorage and reused on every visit,
   and sent as `?token=` on the WebSocket — the only browser-compatible auth
   channel. A wrong key brings the form back with
   *"Secret key rejected (goose answered HTTP 401)"*.
3. To change or forget the key later: open the session drawer and tap
   **Change secret key**. That clears it and reloads to the welcome screen.
4. Share → **Add to Home Screen**. A trusted https origin is what gives a real
   full-screen PWA (service worker + `display-mode: standalone`).

Over plain HTTP the app still works, just without offline caching.

## Local development

```sh
./start.sh          # goose serve + caddy on :8080, plain HTTP
./start.sh status   # shows state and the secret key
./start.sh restart
./start.sh stop
```

The script generates `.env` with a `GOOSE_SERVER__SECRET_KEY` on first run,
starts `goose serve` on `127.0.0.1:3284` with loopback origins, and runs caddy
on `:8080`. Logs go to `./logs/`. No certificates are involved; use the
Pi-hole deployment when you need https and a PWA install.

Open `http://127.0.0.1:8080` and enter the secret key when prompted.

## Accessing from other machines

goose serve rejects WebSocket upgrades whose `Origin` is not loopback. Add the
origin explicitly (this *replaces* the loopback defaults):

```sh
goose serve --host 127.0.0.1 --port 3284 \
  --allowed-origin https://goose.pihole.fritz.box \
  --allowed-origin http://192.168.1.50:8080
```

The client detects a rejected origin and tells you what to do. In the Pi-hole
deployment the unit passes `--allowed-origin https://goose.pihole.fritz.box`
already.

## Features

- Streaming chat (agent text, thinking, plans) with markdown rendering
- Tool-call cards (status, input, diffs, output), collapsible
- **Permission prompts** inline (allow once/always, reject once/always) —
  switch modes (`auto`, `approve`, `smart_approve`, `chat`) from the header pill
- Model / thinking-effort pickers (`session/set_config_option`)
- Session drawer: list, load (full history replay), delete, new chat —
  powered by goose's persisted sessions
- Slash-command completion (`/compact`, `/clear`, …) from
  `available_commands_update`
- Per-session extension toggles (builtin/platform/MCP) in the settings sheet,
  via goose's `_goose/unstable/session/extensions/{list,add,remove}` methods
- Reconnect handling: on socket loss the client reconnects, re-runs
  `initialize` and reloads the session via `session/load`
- PWA: installable, app-shell cache, safe-area insets, no focus-zoom,
  keyboard-aware scrolling

## Configuration

goose serve (environment, see `deploy/pihole/goose.env` / `.env`):

| Setting                     | Meaning                                             |
| --------------------------- | --------------------------------------------------- |
| `GOOSE_SERVER__SECRET_KEY`  | Shared secret; required (or `--dangerously-unauthenticated`) |
| `GOOSE_PROVIDER` / `GOOSE_MODEL` | Model provider for the deployed agent          |
| `GOOSE_THINKING_EFFORT`     | Default thinking effort for new sessions            |
| `--host` / `--port`         | Bind address; keep loopback behind Caddy            |
| `--allowed-origin`          | Exact origins allowed to connect (replaces loopback defaults) |

`public/config.json` (optional, served as-is):

| Key   | Meaning                                   |
| ----- | ----------------------------------------- |
| `cwd` | Default working directory for new sessions; omitted means the server's working directory |

Caddy:

| File | Meaning |
| ---- | ------- |
| `Caddyfile` | standalone local-dev config (`:8080`, no TLS) |
| `deploy/pihole/goose.caddy` | production site block imported by the Pi-hole's main Caddyfile |

`goose.caddy` contains the static root (`/srv/goose-pwa`), the ACME issuer
endpoint and the upstream (`127.0.0.1:3284`). Edit it if goose serve runs on a
different host — but then the ACP traffic leaves the machine unencrypted, so
prefer keeping them together.

> **Security:** anyone with the secret key can drive your goose agent (which
> runs shell commands as the service user). Treat the key like a password and
> keep the app on HTTPS.

## Known limitations

- If the WebSocket drops **while a prompt is streaming**, the in-flight
  chunks are lost; the turn still completes server-side and appears after the
  client reconnects and reloads the session. (goose serve assigns
  `acp-connection-id`s but offers no browser-usable resumption.)
- A permission prompt that is pending exactly when the socket dies is
  stranded; cancel/retry the turn after reconnecting.
- The settings sheet uses `_goose/unstable/...` extension methods, which can
  change between goose releases. The installer pins the goose version this
  client was tested against.

## License

MIT — see [LICENSE](LICENSE).
