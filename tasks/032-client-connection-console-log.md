# Task 032 — Client connection console log

Status: complete

Write a concise line to Tessera's console when a previously unseen web client
reaches the server, without turning every asset request or health poll into a
log entry.

## Behavior

- Identify a client by the security middleware's resolved client IP plus its
  `User-Agent`, so trusted-proxy handling is applied before logging.
- Emit one line per distinct client identity for the lifetime of the Tessera
  process.
- Include the resolved IP address and a short, process-salted SHA-256
  fingerprint of the IP/User-Agent pair.
- Do not print the full User-Agent, cookies, authorization data, query strings,
  request bodies, or other request content.
- Keep the existing optional persistent audit log independent; this console
  connection message is always enabled and is not written to SQLite.
- Make concurrent first requests from one browser produce only one line.

## Example

```text
client connected: ip=192.168.1.42 fingerprint=8d26be4cb4d1
```

## Verification

- Confirm repeated requests from one IP/User-Agent log once.
- Confirm a changed IP or User-Agent produces a distinct log entry and
  fingerprint.
- Confirm trusted-proxy client resolution is used.
- Run `go test ./...` and `go vet ./...`.

## Implementation summary

- Added concurrency-safe first-seen client tracking to the HTTP security
  middleware after effective trusted-proxy metadata is resolved.
- Added an always-on stdout message containing the resolved IP and the first 12
  hexadecimal characters of a process-salted SHA-256 client identity.
- Added tests for deduplication, distinct IP/User-Agent identities, concurrent
  requests, trusted proxy handling, and omission of the full User-Agent.
