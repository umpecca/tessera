# Document terminal known issues and refresh the README

Status: complete.

## Request

Record the unresolved terminal graphics stalls and corruption as known issues,
and update README.md for the current build.

## Changes

- Added `docs/known-issues.md` with observed scope, open status, evidence limits,
  recovery/reporting guidance, and links to the investigations.
- Added prominent README navigation and a known-issues summary. Documented
  partially overlapping terminals, both renderer modes, and canvas recovery.
- Refreshed development checks and linked browser performance diagnostics.
- Corrected the outdated TLS statement to match the existing Local HTTPS
  implementation while retaining the trusted-environment access model.
- Linked terminal-core documentation to the known-issues page and recorded the
  documentation update in the unreleased changelog.

## Validation

- Checked local Markdown links and heading fragments in the touched documents.
- Reviewed wording against the saved measurements and current implementation.
- Documentation-only change; no executable, native core, or live session change.
