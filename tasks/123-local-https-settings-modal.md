# Task 123: Configure local HTTPS from the command palette

Status: complete

Add a Local HTTPS settings modal that is opened from the command palette so
operators can configure Tessera's built-in private certificate authority
without command-line switches.

The modal must show whether local HTTPS is enabled, the HTTPS listen address,
and the DNS names and IP addresses included in the server certificate. It must
validate entries and explain that manually installed roots require full trust
in iPadOS settings. When Tessera is opened through a DNS hostname, prefill that hostname
in the certificate DNS names without duplicating saved names or treating IP
literals and localhost as DNS names.

Persist this configuration alongside host-level Tessera settings. On first
enablement, generate a private root CA and a server certificate using Go's
standard cryptography packages. Store private keys outside the web root with
owner-only permissions, never return a private key through the API, keep the
root stable, and renew the server certificate when it expires or its configured
names change.

When enabled, keep the existing application and WebSocket endpoints on the
primary HTTP listener and serve the same handler over TLS on a separate port.
Use HTTP port 7331 and HTTPS port 7332 by default. Expose only the public root
certificate and setup instructions at `/local-https/` on the HTTP listener, and
show the root fingerprint in both the modal and enrollment page.
Applying changed HTTPS settings must reload only the HTTP/TLS listeners so live
terminal sessions and their native PTYs remain intact. Windows PTY shutdown must
also be idempotent because its process watcher and host shutdown can close the
same session concurrently.

Add focused backend tests for configuration validation, persistence,
certificate generation and renewal, TLS startup, and enrollment responses. Add
frontend tests for the command-palette action, modal state, validation, saving,
and restart messaging. Update the README with the iPadOS enrollment flow.

Validation:

- 274 frontend tests passed
- `go test ./...` passed
- `go vet ./...` passed
- Production web bundle rebuilt with `npm run build:web`
- Focused tests cover settings persistence, validation, stable root identity,
  server-certificate renewal, missing leaf-key recovery, CA enrollment,
  API-triggered listener reload with a surviving active terminal, trusted TLS
  startup, idempotent terminal shutdown, Windows/Unix port-conflict reporting,
  and command-palette modal behavior
- `git diff --check` passed
