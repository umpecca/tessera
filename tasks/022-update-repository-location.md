# Task 022: Update self-update repository location

Status: complete

Point Tessera's self-updater at the public `umpecca/tessera` GitHub repository.
The latest-release lookup and binary asset download must continue through the
existing updater flow, with no authentication requirement for public releases.

- Replace the old `bently0602/tessera` runtime repository configuration.
- Update stale repository examples in the updater code.
- Verify the updater tests and the repository's public GitHub release endpoint.

Implemented by changing the runtime `updateRepo` constant to
`umpecca/tessera` and updating the updater's repository example.

Verification:

- `go test ./...`
- GitHub repository API returned `200` with `private: false`.
- Latest-release API returned `200` for `v1.2.0`, with matching Windows,
  macOS, and Linux binary assets.
