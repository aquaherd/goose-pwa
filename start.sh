#!/usr/bin/env bash
# goose-pwa service manager: goose serve (ACP/WebSocket) + caddy (static PWA).
#
#   ./start.sh            start anything that isn't running (default)
#   ./start.sh restart    stop everything, then start
#   ./start.sh stop       stop both
#   ./start.sh status     show state
#
# Logs go to ./logs/. The goose secret key lives in ./.env (generated on first
# run). Edit ORIGINS below if you add hostnames — --allowed-origin REPLACES
# the loopback defaults, so keep the loopback entries.

set -euo pipefail
cd "$(dirname "$0")"

GOOSE_HOST=127.0.0.1
GOOSE_PORT=3284
# Default thinking effort for NEW sessions (off|low|medium|high|max).
# Every new session starts at this value; it can still be changed per session
# from the PWA "Session settings" sheet. Override in .env to keep it.
GOOSE_THINKING_EFFORT="${GOOSE_THINKING_EFFORT:-off}"
export GOOSE_THINKING_EFFORT

ORIGINS=(
  "http://omv.fritz.box:8080"
  "https://omv.fritz.box"
  "http://127.0.0.1:8080"
  "http://localhost:8080"
)

mkdir -p logs

if [[ ! -f .env ]]; then
  umask 077
  printf 'GOOSE_SERVER__SECRET_KEY=%s\n' "$(openssl rand -hex 24)" > .env
  echo "start.sh: generated .env with a fresh GOOSE_SERVER__SECRET_KEY"
fi
set -a; source ./.env; set +a

goose_running() { curl -sf --max-time 2 "http://$GOOSE_HOST:$GOOSE_PORT/status" >/dev/null 2>&1; }
caddy_ok()      { curl -sf --max-time 2 -o /dev/null "http://127.0.0.1:8080/" 2>/dev/null; }

stop_all() {
  pkill -u "$USER" -f "^goose serve " 2>/dev/null && echo "stopped goose serve" || true
  pkill -u "$USER" -f "caddy run --config Caddyfile" 2>/dev/null && echo "stopped caddy" || true
  sleep 1
}

start_goose() {
  if goose_running; then echo "goose serve: already running on :$GOOSE_PORT"; return; fi
  local args=(--host "$GOOSE_HOST" --port "$GOOSE_PORT")
  local o
  for o in "${ORIGINS[@]}"; do args+=(--allowed-origin "$o"); done
  setsid nohup goose serve "${args[@]}" >>logs/goose-serve.log 2>&1 < /dev/null &
  for _ in $(seq 1 20); do goose_running && break; sleep 0.5; done
  if goose_running; then
    echo "goose serve: up on $GOOSE_HOST:$GOOSE_PORT (origins: ${ORIGINS[*]})"
  else
    echo "goose serve: FAILED — see logs/goose-serve.log" >&2; exit 1
  fi
}

start_caddy() {
  # avoid duplicate instances racing on :8080 (SO_REUSEPORT)
  local running
  running=$( (pgrep -u "$USER" -f "caddy run --config Caddyfile" || true) | wc -l)
  if (( running > 1 )); then
    echo "caddy: $running duplicate instances found — killing all, starting one"
    pkill -u "$USER" -f "caddy run --config Caddyfile" || true
    sleep 1
    running=0
  fi
  if (( running == 1 )) && caddy_ok; then echo "caddy: already running on :8080"; return; fi
  setsid nohup caddy run --config Caddyfile >>logs/caddy.log 2>&1 < /dev/null &
  for _ in $(seq 1 20); do caddy_ok && break; sleep 0.5; done
  if caddy_ok; then
    echo "caddy: up on :8080"
  else
    echo "caddy: FAILED — see logs/caddy.log" >&2; exit 1
  fi
}

cmd_status() {
  if goose_running; then echo "goose serve: up (:$GOOSE_PORT)"; else echo "goose serve: DOWN"; fi
  if caddy_ok; then echo "caddy: up (:8080)"; else echo "caddy: DOWN"; fi
  if goose_running && caddy_ok; then
    echo "secret: $GOOSE_SERVER__SECRET_KEY"
  fi
}

case "${1:-start}" in
  start)   start_goose; start_caddy ;;
  stop)    stop_all ;;
  restart) stop_all; start_goose; start_caddy ;;
  status)  cmd_status ;;
  *) echo "usage: $0 [start|stop|restart|status]" >&2; exit 2 ;;
esac
