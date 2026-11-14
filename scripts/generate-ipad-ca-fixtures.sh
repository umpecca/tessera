#!/usr/bin/env bash
# Regenerates the CA-signed loopback identities for the iPad UI tests:
# ca-a1 and ca-a2 are two leaves from one CA (a renewal), ca-b1 is from
# another CA. Each PKCS#12 holds its leaf key, leaf and CA. iPadOS rejects TLS
# leaves valid for more than 825 days, so rerun this before they expire.

set -Eeuo pipefail

readonly FIXTURES="$(cd "$(dirname "$0")/../apple/TesseraUITests/Fixtures" && pwd)"
readonly WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ca() {
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
    -subj "/O=Tessera fixtures/CN=Tessera Fixture Root CA $1" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$WORK/ca-$1.key" -out "$WORK/ca-$1.crt" 2>/dev/null
}

leaf() {
  local name="$1" authority="$2"
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/O=Tessera fixtures/CN=localhost" \
    -keyout "$WORK/$name.key" -out "$WORK/$name.csr" 2>/dev/null
  printf '%s\n' "basicConstraints=critical,CA:FALSE" "keyUsage=critical,digitalSignature" \
    "extendedKeyUsage=serverAuth" "subjectAltName=DNS:localhost,IP:127.0.0.1" > "$WORK/$name.ext"
  openssl x509 -req -in "$WORK/$name.csr" -CA "$WORK/ca-$authority.crt" -CAkey "$WORK/ca-$authority.key" \
    -CAcreateserial -days 820 -sha256 -extfile "$WORK/$name.ext" -out "$WORK/$name.crt" 2>/dev/null
  openssl pkcs12 -export -inkey "$WORK/$name.key" -in "$WORK/$name.crt" -certfile "$WORK/ca-$authority.crt" \
    -passout pass:fixture-only -out "$FIXTURES/loopback-$name.p12"
}

ca a
ca b
leaf ca-a1 a
leaf ca-a2 a
leaf ca-b1 b
echo "Wrote loopback-ca-{a1,a2,b1}.p12 to $FIXTURES; leaves expire $(openssl x509 -in "$WORK/ca-a1.crt" -noout -enddate | cut -d= -f2)"
