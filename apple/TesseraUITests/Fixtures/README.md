# Loopback TLS test identities

`loopback-a.p12` and `loopback-b.p12` are generated, self-signed test identities
for `localhost` / `127.0.0.1`, with intentionally different keys/certificates.
The PKCS#12 password is `fixture-only`. Their private keys are test data, not
production secrets. Do not install or trust them in a system certificate store.

Native UI tests use them only in generated loopback servers on a disposable
iPad simulator to exercise certificate acceptance, persistence and replacement.
The app target does not include this directory.

`loopback-ca-a1.p12`, `loopback-ca-a2.p12` and `loopback-ca-b1.p12` hold
`localhost` / `127.0.0.1` leaves with their issuing CA (same password). `ca-a1`
and `ca-a2` share a CA, standing in for a Local HTTPS renewal; `ca-b1` has
another CA. iPadOS rejects TLS leaves valid for more than 825 days, so these
expire on 2029-02-11; regenerate them with `scripts/generate-ipad-ca-fixtures.sh`.
