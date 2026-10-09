# Configurable terminal shortcuts

Status: implemented and verified (Mac browser/native verification pending)

Implement the approved terminal launcher design: per-user shortcuts managed in a
modal with add/edit/duplicate/delete/test. Configure name, two-letter palette code,
single-line base command, optional host working directory and ordered invocation
fields (text, positional arguments, boolean switches, defaults and required flags).
Empty optional text omits its switch. Input values are quoted by the host for the
terminal shell. Launch a new terminal, with no automatic execution on restoration.

Wire saved shortcuts into the command palette and Command Wheel; reject collisions
with built-in codes and other shortcuts. Persist independently with revision checks
so concurrent browsers cannot silently overwrite definitions. Preserve unsaved
forms when reporting errors and discard stale asynchronous responses after user or
workspace changes.

Test persistence, collisions, argument quoting/injection, optional/default/required
inputs, HTTP authorization and concurrency, modal actions, real terminal launch,
reload and palette/wheel behavior. Run Go/JS suites and browser smoke tests.

Implemented:
- Per-user SQLite definitions, migration 047, independent revision comparisons,
  strict API validation, session ownership and absolute host directory checks.
- Modal management, ordered inputs, defaults/required/boolean fields, drafts,
  duplicates, delete confirmation, and Test without saving.
- Custom two-letter palette and Command Wheel codes; built-in collisions rejected.
- Host shell quoting for literal values. Commands launch once in new terminals;
  workspace serialization excludes their transient startup commands.
- Generation/context checks discard cancelled, switched-user/session, and late
  responses. Conflicts and launch errors preserve entered values and drafts.
- README usage examples, architecture/API/schema documentation and changelog.

Verification:
- Full Go suite and go vet pass. Combined JavaScript suites pass (550 tests).
- Browser bundles rebuild and terminal-core reproducibility passes, preserving
  protocol 2 and hash 2a049087c683ca37d4fca3b5d73418c0a15984fdaa3d4ac78fec7313798030a4.
- Real app/host/PTY tests in Chrome 154, Edge 154 and Firefox 153 pass: management,
  duplicate/delete, CE palette/wheel invocation, literal Unicode/apostrophe/space/
  dollar/semicolon arguments and cwd, optional omission/boolean switches,
  new terminal, reload without rerun, cancellation, unsaved Test, and conflict
  preservation/reload. Modal screenshots inspected.
- Safari/macOS native preview cannot be tested on this Windows host.

Existing tasks 171/172/173 remain intact. No commit, push or release performed.
