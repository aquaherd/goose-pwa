#!/usr/bin/env bash
# Regenerate the local CA + server leaf + CRL, and (re)start the OCSP responder.
# Usage: ./scripts/make-cert.sh [hostname]   (default: omv.fritz.box)
#
# iOS needs a *positive* revocation answer: the leaf gets BOTH a CRL
# Distribution Point and an OCSP responder (authorityInfoAccess), served at
# http://<host>:8080/crl.pem and /ocsp (plain http so there's no trust loop).
# Install certs/ca.crt on the iPhone and enable full trust once.
set -euo pipefail
cd "$(dirname "$0")/.."
host="${1:-omv.fritz.box}"
mkdir -p certs
CA_STATE=certs/.ca
mkdir -p "$CA_STATE/newcerts"
: > "$CA_STATE/index.txt"
: > "$CA_STATE/index.txt.attr"
echo 1000 > "$CA_STATE/serial"
echo 1000 > "$CA_STATE/crlnumber"
chmod 700 "$CA_STATE"

# --- local CA (kept stable unless you delete it) ---
if [[ ! -f certs/ca.crt ]]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 825 \
    -keyout certs/ca.key -out certs/ca.crt \
    -subj "/CN=goose-pwa local CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,digitalSignature" \
    -addext "subjectKeyIdentifier=hash"
  chmod 600 certs/ca.key
fi

# --- openssl ca config ---
cat > "$CA_STATE/ca.cnf" <<CNF
[ ca ]
default_ca = CA_default
[ CA_default ]
dir = $(pwd)/$CA_STATE
database = $(pwd)/$CA_STATE/index.txt
new_certs_dir = $(pwd)/$CA_STATE/newcerts
certificate = $(pwd)/certs/ca.crt
private_key = $(pwd)/certs/ca.key
serial = $(pwd)/$CA_STATE/serial
crlnumber = $(pwd)/$CA_STATE/crlnumber
default_md = sha256
default_days = 825
policy = policy_any
unique_subject = no
[ policy_any ]
commonName = supplied
[ crl_ext ]
authorityKeyIdentifier = keyid:always
CNF

# --- leaf extensions ---
cat > "$CA_STATE/leaf.ext" <<EXT
subjectAltName=DNS:$host,DNS:localhost,IP:127.0.0.1
basicConstraints=critical,CA:FALSE
extendedKeyUsage=serverAuth
keyUsage=critical,digitalSignature,keyEncipherment
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
crlDistributionPoints=URI:http://$host:8080/crl.pem
authorityInfoAccess=OCSP;URI:http://$host:8080/ocsp
EXT

# --- server key + leaf (registered in the CA index so OCSP works) ---
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout certs/server.key -out "$CA_STATE/server.csr" \
  -subj "/CN=$host"
openssl ca -batch -notext -config "$CA_STATE/ca.cnf" \
  -extfile "$CA_STATE/leaf.ext" \
  -in "$CA_STATE/server.csr" -out certs/server.crt
rm -f "$CA_STATE/server.csr"
chmod 600 certs/server.key

# --- CRL (825d, matches cert lifetime) ---
openssl ca -gencrl -config "$CA_STATE/ca.cnf" -out certs/ca.crl -crldays 825

# leaf + CA, for the TLS handshake chain
cat certs/server.crt certs/ca.crt > certs/fullchain.pem
chmod 600 certs/fullchain.pem

echo "wrote certs/ca.{crt,key}, certs/server.{crt,key}, certs/ca.crl"
echo "install certs/ca.crt on the iPhone (http://$host:8080/cert.crt) + full trust"
echo "then: ./start.sh restart   (also (re)starts the OCSP responder)"
