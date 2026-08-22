# goose-pwa

An iPhone-friendly PWA frontend for [goose](https://github.com/block/goose),
talking **ACP (Agent Client Protocol)** over WebSocket to `goose serve`,
served by **Caddy**. No build step, no Node, no dependencies — static files
plus two processes.

## Architecture

```
 iPhone (Safari / Home-Screen PWA)
    │  HTTPS: static files + WebSocket
    ▼
 Caddy ──── static: public/
    │        /acp, /status → 127.0.0.1:3284
    ▼
 goose serve        (ACP over HTTP/WebSocket, secret-key auth)
```

The browser speaks ACP (JSON-RPC 2.0) directly to goose's WebSocket endpoint
(`/acp`). Caddy only serves the app shell and reverse-proxies the socket.
There is no bridge process.

## Quick start

```sh
# 1. goose ACP server (pick a strong secret)
export GOOSE_SERVER__SECRET_KEY="$(openssl rand -hex 24)"
goose serve --host 127.0.0.1 --port 3284

# 2. caddy (from the project root)
caddy run --config Caddyfile
```

Open `http://<host>:8080` and enter the secret key when prompted
(it is stored in localStorage and sent as `?token=` on the WebSocket —
the only browser-compatible auth channel).

### Accessing from other machines (iPhone on the LAN)

goose serve rejects WebSocket upgrades whose `Origin` is not loopback.
Two options:

1. **Allow the origin explicitly** (recommended):

   ```sh
   goose serve --host 127.0.0.1 --port 3284 \
     --allowed-origins http://192.168.1.50:8080 \
     --allowed-origins https://goose.home.arpa
   ```

   Note: setting `--allowed-origins` *replaces* the default loopback
   origins — list every origin you use.

2. Or neutralize the origin check at the proxy by uncommenting
   `header_up Origin "http://127.0.0.1"` in the `handle /acp*` block of the
   Caddyfile. The secret key remains the real authentication.

The client detects a rejected origin and tells you what to do.

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
- Reconnect handling: on socket loss the client reconnects, re-runs
  `initialize` and reloads the session via `session/load`
- PWA: installable, app-shell cache, safe-area insets, no focus-zoom,
  keyboard-aware scrolling

## Configuration

goose serve:

| Setting                     | Meaning                                             |
| --------------------------- | --------------------------------------------------- |
| `GOOSE_SERVER__SECRET_KEY`  | Shared secret; required (or `--dangerously-unauthenticated`) |
| `--host` / `--port`         | Bind address; keep loopback behind Caddy            |
| `--allowed-origins`         | Exact origins allowed to connect (replaces loopback defaults) |
| `--tls`                     | Not needed behind Caddy (Caddy terminates TLS)      |

`public/config.json`:

| Key   | Meaning                              |
| ----- | ------------------------------------ |
| `cwd` | Default working directory for new sessions |

Caddy (adapt-time env):

| Variable            | Default              | Meaning               |
| ------------------- | -------------------- | --------------------- |
| `SITE_ADDRESS`      | `:8080`              | Caddy site address    |
| `SITE_ROOT`         | `./public`           | Static files root     |
| `GOOSE_SERVE_ADDR`  | `127.0.0.1:3284`     | goose serve upstream  |

> **Security:** anyone with the secret key can drive your goose agent (which
> runs shell commands as you). Treat the key like a password and prefer HTTPS
> so it isn't sent in cleartext URLs.

## Known limitations

- If the WebSocket drops **while a prompt is streaming**, the in-flight
  chunks are lost; the turn still completes server-side and appears after the
  client reconnects and reloads the session. (goose serve assigns
  `acp-connection-id`s but offers no browser-usable resumption.)
- A permission prompt that is pending exactly when the socket dies is
  stranded; cancel/retry the turn after reconnecting.

## systemd (optional)

```ini
# ~/.config/systemd/user/goose-serve.service
[Unit]
Description=goose ACP server
After=network.target

[Service]
Environment=GOOSE_SERVER__SECRET_KEY=change-me
ExecStart=/usr/local/bin/goose serve --host 127.0.0.1 --port 3284
Restart=on-failure

[Install]
WantedBy=default.target
```

Caddy can run the same way with
`ExecStart=/usr/bin/caddy run --config /path/to/Caddyfile`.
