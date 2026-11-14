# Loopback TLS test identities

`loopback-a.p12` and `loopback-b.p12` are generated, self-signed test identities
for `localhost` / `127.0.0.1`, with intentionally different keys/certificates.
The PKCS#12 password is `fixture-only`. Their private keys are test data, not
production secrets. Do not install or trust them in a system certificate store.

Native UI tests use them only in generated loopback servers on a disposable
iPad simulator to exercise certificate acceptance, persistence and replacement.
The app target does not include this directory.
