# Task 028 — Encoder distribution

Status: complete

The release workflow builds pinned LAME 3.100 sidecars for Windows amd64, Linux
amd64, macOS amd64, and macOS arm64 while preserving existing Tessera binary
asset names. Releases publish the LGPL license and corresponding source archive.

Self-update requires both assets, stops live capture, installs the pair with
rollback, and supports exact-version companion bootstrap after a legacy
binary-only upgrade.
