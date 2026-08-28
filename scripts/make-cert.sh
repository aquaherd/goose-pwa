#!/usr/bin/env bash
# Regenerate the self-signed certificate for the HTTPS listener.
# Usage: ./scripts/make-cert.sh [hostname]   (default: omv.fritz.box)
set -euo pipefail
cd "$(dirname "$0")/.."
host="${1:-omv.fritz.box}"
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 825 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=$host" \
  -addext "subjectAltName=DNS:$host,DNS:localhost,IP:127.0.0.1"
chmod 600 certs/server.key
echo "wrote certs/server.crt + certs/server.key for $host"
echo "restart caddy: ./start.sh restart"
