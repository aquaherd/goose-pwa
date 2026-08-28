#!/usr/bin/env bash
# Regenerate the local CA and server leaf for the HTTPS listener.
# Usage: ./scripts/make-cert.sh [hostname]   (default: omv.fritz.box)
#
# The CA (certs/ca.crt) is the one to install on the iPhone
# (http://<host>:8080/cert.crt) and enable full trust; the server leaf
# certs/server.crt chains to it. This avoids iOS's "revocation data"
# trust failure that plain self-signed leaves hit.
set -euo pipefail
cd "$(dirname "$0")/.."
host="${1:-omv.fritz.box}"
mkdir -p certs

# local CA
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 825 \
  -keyout certs/ca.key -out certs/ca.crt \
  -subj "/CN=goose-pwa local CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,digitalSignature" \
  -addext "subjectKeyIdentifier=hash"

# server key + CSR
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout certs/server.key -out /tmp/goose-pwa-server.csr \
  -subj "/CN=$host"

# leaf extension policy
cat > /tmp/goose-pwa-leaf.ext <<EXT
subjectAltName=DNS:$host,DNS:localhost,IP:127.0.0.1
basicConstraints=critical,CA:FALSE
extendedKeyUsage=serverAuth
keyUsage=critical,digitalSignature,keyEncipherment
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
EXT

# sign leaf with the CA
openssl x509 -req -in /tmp/goose-pwa-server.csr -CA certs/ca.crt -CAkey certs/ca.key \
  -CAcreateserial -days 825 -sha256 -out certs/server.crt \
  -extfile /tmp/goose-pwa-leaf.ext
rm -f /tmp/goose-pwa-server.csr /tmp/goose-pwa-leaf.ext
# CRL for the leaf's CRLDistributionPoints (served at /crl.pem); expiry
# matches the certificate lifetime so iOS never sees an expired CRL.
mkdir -p /tmp/goose-pwa-crl/newcerts
: > /tmp/goose-pwa-crl/index.txt
echo 1000 > /tmp/goose-pwa-crl/serial
cat > /tmp/goose-pwa-crl.cnf <<CNF
[ ca ]
default_ca = CA_default
[ CA_default ]
dir = /tmp/goose-pwa-crl
database = /tmp/goose-pwa-crl/index.txt
new_certs_dir = /tmp/goose-pwa-crl/newcerts
certificate = certs/ca.crt
private_key = certs/ca.key
serial = /tmp/goose-pwa-crl/serial
default_md = sha256
policy = policy_any
[ policy_any ]
commonName = supplied
[ crl_ext ]
authorityKeyIdentifier = keyid:always
CNF
openssl ca -gencrl -config /tmp/goose-pwa-crl.cnf -out certs/ca.crl -crldays 825

chmod 600 certs/ca.key certs/server.key
echo "wrote certs/ca.{crt,key} + certs/server.{crt,key} + certs/ca.crl for $host"
echo "install certs/ca.crt on the iPhone (use /cert.crt), enable full trust"
echo "then restart caddy: ./start.sh restart"
