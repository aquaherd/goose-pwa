# goose-pwa

An iPhone-friendly PWA frontend for [goose](https://github.com/block/goose),
talking **ACP (Agent Client Protocol)** to `goose acp`, served by **Caddy**.

## Architecture

```
 iPhone (Safari / Home-Screen PWA)
    │  HTTPS: static files + SSE + POST
    ▼
 Caddy ──── static: public/
    │        /api/* → 127.0.0.1:8787   (flush_interval -1 for SSE)
    ▼
 bridge/server.mjs  (Node ≥ 18, zero dependencies)
    │  newline-delimited JSON-RPC 2.0 over stdio (ACP v1)
    ▼
 goose acp
```

`goose acp` speaks JSON-RPC over stdio, which a browser cannot reach — so a
small bridge process owns one long-lived `goose acp` child and exposes:

| Endpoint        | Direction      | Purpose                                          |
| --------------- | -------------- | ------------------------------------------------ |
| `GET /api/events?since=N` | bridge → browser | SSE stream of every message from goose; replays messages after sequence `N` (reconnect-safe). |
| `POST /api/send`          | browser → bridge | Any JSON-RPC message (requests *and* responses to agent→client requests). Responses to requests arrive asynchronously via the SSE stream. |
| `GET /api/health`         | —                | Bridge/agent status.                             |

The bridge performs the ACP `initialize` handshake itself, keeps a replay ring
buffer (default 2000 messages), restarts goose on crash with backoff, and bumps
an `epoch` counter so clients resync (re-`session/load`) after a restart.

## Quick start

```sh
npm start              # bridge on 127.0.0.1:8787
npm run caddy          # caddy on :8080, serving ./public
```

Open `http://<host>:8080` — on the iPhone use the LAN IP of the machine.

### Install on iPhone (Add to Home Screen)

1. Serve over HTTPS (service workers require a secure context):
   - real domain: `SITE_ADDRESS="goose.example.com" caddy run --config Caddyfile`, or
   - LAN name with Caddy's internal CA: `SITE_ADDRESS="https://goose.home.arpa"`
     plus a `tls internal` line in the Caddyfile, then install Caddy's root
     certificate on the iPhone and enable it under
     *Settings → General → About → Certificate Trust Settings*.
2. Open the site in Safari → Share → **Add to Home Screen**.

Over plain HTTP the app still works, just without offline caching.

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
- Reconnect-safe: SSE replay buffer + session resync after bridge/goose restart
- PWA: installable, app-shell cache, safe-area insets, no focus-zoom,
  keyboard-aware scrolling

## Configuration (environment)

Bridge:

| Variable          | Default       | Meaning                                     |
| ----------------- | ------------- | ------------------------------------------- |
| `PORT`            | `8787`        | Bridge listen port                          |
| `HOST`            | `127.0.0.1`   | Bridge listen address (keep it loopback)    |
| `GOOSE_BIN`       | `goose`       | Path to the goose binary                    |
| `GOOSE_CWD`       | bridge cwd    | Default working directory for new sessions  |
| `GOOSE_PWA_TOKEN` | *(unset)*     | If set, clients must present this bearer token (header or `?token=`) |
| `BUFFER_SIZE`     | `2000`        | SSE replay buffer entries                   |

Caddy (adapt-time):

| Variable        | Default              | Meaning                    |
| --------------- | -------------------- | -------------------------- |
| `SITE_ADDRESS`  | `:8080`              | Caddy site address         |
| `SITE_ROOT`     | `./public`           | Static files root          |
| `BRIDGE_ADDR`   | `127.0.0.1:8787`     | Bridge upstream            |

> **Security:** without `GOOSE_PWA_TOKEN` anyone who can reach the Caddy port
> can drive your goose agent (which runs shell commands as you). At minimum
> keep it on a trusted LAN; set a token if exposed further.

## systemd (optional)

```ini
# ~/.config/systemd/user/goose-pwa-bridge.service
[Unit]
Description=goose-pwa bridge
After=network.target

[Service]
WorkingDirectory=%h/Projects/github/aquaherd/goose-pwa
Environment=GOOSE_PWA_TOKEN=change-me
ExecStart=/usr/bin/node bridge/server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

Caddy can run the same way with `ExecStart=/usr/bin/caddy run --config Caddyfile`.
