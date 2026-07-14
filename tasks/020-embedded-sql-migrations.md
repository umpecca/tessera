# Task 020: Embedded SQL migration sequence

Status: complete

Replace the duplicated SQLite schema definitions in `internal/store/store.go`,
`migrations/001_init.sql`, and the imperative `ALTER TABLE` guards with one
ordered SQL migration sequence embedded into the executable.

- Use numbered SQL files as the only application-schema DDL source.
- Track the applied migration version with SQLite `PRAGMA user_version`.
- Apply each migration transactionally and reject missing or duplicate version
  numbers.
- Preserve fresh database creation and automatic adoption of existing
  unversioned Tessera databases without losing workspace, pane, session, or
  user-setting data.
- Ensure `editor_tabs` and every other persisted field are created through the
  same sequence.
- Add focused tests for fresh schema creation, migration idempotence, and legacy
  database adoption.
- Update architecture documentation to identify the embedded sequence as the
  single schema source of truth.

Implemented `migrations/embed.go` plus contiguous migrations 001 through 025.
`internal/store/store.go` now validates and transactionally applies the embedded
sequence, records progress with `PRAGMA user_version`, rejects databases newer
than the executable, and safely adopts duplicate one-column migrations from
pre-versioned databases. The previous `initSQL`, schema maps, and imperative
column guards were removed.

Migration tests cover fresh schema creation, all current pane/workspace fields,
`editor_tabs`, idempotent reopen, sequence gaps and duplicates, transactional
rollback, old workspace conversion, and preservation of named sessions and user
settings while adopting a current unversioned database. The full Go test suite,
`go vet ./...`, and CGO-free Windows/Linux builds pass.
