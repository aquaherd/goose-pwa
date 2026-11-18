#!/usr/bin/env bash
# Install goose-pwa on the Pi-hole (run as root, on the Pi itself).
#
#   sudo ./deploy/pihole/install.sh
#
# Idempotent: re-run it after a git pull to refresh the app and unit. It
#   * copies public/ to /srv/goose-pwa
#   * installs goose (pinned version) and a goose-serve systemd unit
#   * creates /etc/goose-pwa/goose.env with a fresh secret key (once)
#   * adds the DNS record for goose.pihole.fritz.box to pihole's dns.hosts
#   * installs the Caddy site block and imports it from /etc/caddy/Caddyfile
#
# TLS comes from HomeCA's step-ca over ACME; nothing here creates or stores
# certificates. HomeCA must already serve pihole.fritz.box with its root at
# /etc/caddy/homeca-root.crt.

set -euo pipefail

SITE=goose.pihole.fritz.box
LAN_IP=192.168.188.3
PREFIX=/srv/goose-pwa
CONF_DIR=/etc/goose-pwa
GOOSE_USER=goose
GOOSE_HOME=/home/goose
GOOSE_BIN=/usr/local/bin/goose
GOOSE_VERSION=${GOOSE_VERSION:-1.55.0}
GOOSE_ARCH=aarch64-unknown-linux-gnu
CADDY_MAIN=/etc/caddy/Caddyfile
CADDY_SNIPPET=/etc/caddy/goose.caddy
HOME_CA_ROOT=/etc/caddy/homeca-root.crt
REPO=$(cd "$(dirname "$0")/../.." && pwd)

step() { printf '\n== %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "error: run with sudo" >&2; exit 1; }
[[ -f $CADDY_MAIN ]] || { echo "error: $CADDY_MAIN not found (HomeCA not installed?)" >&2; exit 1; }
[[ -f $HOME_CA_ROOT ]] || { echo "error: $HOME_CA_ROOT not found (install HomeCA's root first)" >&2; exit 1; }

step "static app -> $PREFIX"
install -d -m 0755 "$PREFIX"
rsync -a --delete --exclude '.git*' --exclude 'config.json' "$REPO/public/" "$PREFIX/"
# the working directory for new sessions: goose requires an absolute path and
# has no server-side default, so it is written per deployment
printf '{"cwd": "%s"}\n' "$GOOSE_HOME/workspace" >"$PREFIX/config.json"
chmod 0644 "$PREFIX/config.json"

step "service user $GOOSE_USER"
if ! id -u "$GOOSE_USER" >/dev/null 2>&1; then
	useradd --create-home --home-dir "$GOOSE_HOME" --shell /bin/bash "$GOOSE_USER"
	echo "created $GOOSE_USER"
fi
install -d -o "$GOOSE_USER" -g "$GOOSE_USER" -m 0755 "$GOOSE_HOME/workspace"

step "goose $GOOSE_VERSION -> $GOOSE_BIN"
if [[ -x $GOOSE_BIN ]] && "$GOOSE_BIN" --version 2>/dev/null | grep -q "$GOOSE_VERSION"; then
	echo "already installed: $("$GOOSE_BIN" --version)"
else
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	url="https://github.com/block/goose/releases/download/v${GOOSE_VERSION}/goose-${GOOSE_ARCH}.tar.gz"
	echo "downloading $url"
	curl -fL --retry 3 --silent --show-error "$url" -o "$tmp/goose.tar.gz"
	tar -xzf "$tmp/goose.tar.gz" -C "$tmp"
	bin=$(find "$tmp" -maxdepth 2 -type f -name goose -perm -u+x | head -n 1)
	[[ -n $bin ]] || { echo "error: no goose binary in the release tarball" >&2; exit 1; }
	install -m 0755 "$bin" "$GOOSE_BIN"
	echo "installed: $("$GOOSE_BIN" --version)"
fi

step "config $CONF_DIR/goose.env"
install -d -m 0755 "$CONF_DIR"
if [[ ! -f $CONF_DIR/goose.env ]]; then
	(umask 077; {
		echo "GOOSE_SERVER__SECRET_KEY=$(openssl rand -hex 24)"
		echo "GOOSE_THINKING_EFFORT=off"
		cat <<'EOF'
# Model provider for this host (uncomment and fill in; alternative:
#   sudo -iu goose goose configure
# GOOSE_PROVIDER=opencode_go
# GOOSE_MODEL=deepseek-v4.1-flash
# OPENCODE_API_KEY=
EOF
	} >"$CONF_DIR/goose.env")
	chmod 600 "$CONF_DIR/goose.env"
	echo "wrote $CONF_DIR/goose.env (read the secret with: sudo cat $CONF_DIR/goose.env)"
else
	echo "kept existing $CONF_DIR/goose.env"
fi

step "goose-serve.service"
install -m 0644 "$REPO/deploy/pihole/goose-serve.service" /etc/systemd/system/goose-serve.service
systemctl daemon-reload
systemctl enable goose-serve >/dev/null
systemctl restart goose-serve

step "DNS: $SITE -> $LAN_IP"
if grep -q "$SITE" /etc/pihole/pihole.toml; then
	echo "record already present"
else
	cp -a /etc/pihole/pihole.toml "/etc/pihole/pihole.toml.bak-$(date +%Y%m%d%H%M%S)"
	python3 - "$SITE" "$LAN_IP" <<'PY'
import re, sys
site, ip = sys.argv[1], sys.argv[2]
path = "/etc/pihole/pihole.toml"
s = open(path).read()
entry = f"{ip} {site}"
m = re.search(r'(?ms)^([ \t]*)hosts[ \t]*=[ \t]*\[(.*?)^[ \t]*\]', s)
if not m:
    sys.exit("error: dns.hosts array not found in pihole.toml")
inner = m.group(2).rstrip()
lines = inner.split("\n")
idx = next((i for i in range(len(lines) - 1, -1, -1) if '"' in lines[i]), None)
indent = re.match(r"[ \t]*", lines[idx]).group(0) if idx is not None else "    "
if idx is None:
    lines = [f'{indent}"{entry}"']
else:
    if not lines[idx].rstrip().endswith(","):
        lines[idx] = lines[idx].rstrip() + ","
    lines.insert(idx + 1, f'{indent}"{entry}"')
new = m.group(1) + "hosts = [\n" + "\n".join(lines) + "\n" + m.group(1) + "]"
open(path, "w").write(s[:m.start()] + new + s[m.end():])
print(f"added {entry}")
PY
	pihole reloaddns
fi

step "Caddy log redaction"
if grep -q "goose-pwa: redact" "$CADDY_MAIN"; then
	echo "already present"
else
	cp -a "$CADDY_MAIN" "$CADDY_MAIN.bak-$(date +%Y%m%d%H%M%S)"
	python3 - "$CADDY_MAIN" <<'PY'
import re, sys

path = sys.argv[1]
src = open(path).read()
block = (
    "\t# goose-pwa: redact the WebSocket secret from error logs. Caddy logs\n"
    "\t# the request URI on proxy errors, and the ACP token travels as ?token=.\n"
    "\tlog {\n"
    "\t\tformat filter {\n"
    "\t\t\twrap json\n"
    "\t\t\tfields {\n"
    "\t\t\t\trequest>uri query {\n"
    "\t\t\t\t\tdelete token\n"
    "\t\t\t\t}\n"
    "\t\t\t}\n"
    "\t\t}\n"
    "\t}\n"
)
m = re.search(r"(?ms)^\{[ \t]*\n(.*?)^\}", src)
if not m:
    sys.exit("error: global options block not found in " + path)
open(path, "w").write(src[: m.end(1)] + block + src[m.end(1):])
print("added token redaction to the global options block")
PY
fi

step "Caddy site block"
install -m 0644 "$REPO/deploy/pihole/goose.caddy" "$CADDY_SNIPPET"
if grep -qx "import $CADDY_SNIPPET" "$CADDY_MAIN"; then
	echo "import already present"
else
	cp -a "$CADDY_MAIN" "$CADDY_MAIN.bak-$(date +%Y%m%d%H%M%S)"
	printf '\n# goose-pwa (https://%s)\nimport %s\n' "$SITE" "$CADDY_SNIPPET" >>"$CADDY_MAIN"
	echo "added import to $CADDY_MAIN"
fi
caddy validate --config "$CADDY_MAIN" --adapter caddyfile >/dev/null
systemctl reload caddy

step "waiting for $SITE"
for _ in $(seq 1 60); do
	if curl -sf --max-time 3 --cacert "$HOME_CA_ROOT" "https://$SITE/status" >/dev/null 2>&1; then
		echo "https://$SITE is live"
		break
	fi
	sleep 2
done
if ! curl -sf --max-time 3 --cacert "$HOME_CA_ROOT" "https://$SITE/status" >/dev/null 2>&1; then
	echo "warning: $SITE not answering yet — check: journalctl -u caddy -n 50" >&2
fi

step "done"
cat <<EOF
PWA:     https://$SITE
secret:  sudo cat $CONF_DIR/goose.env   (enter it once in the app)
agent:   systemctl status goose-serve
EOF
