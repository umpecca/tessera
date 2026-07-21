# Task 044: Default wheel sensitivity

Status: complete

Change the default scroll-wheel sensitivity to `1.5×` for both terminal and
editor settings.

## Requirements

- New users receive `1.5×` terminal wheel sensitivity and `1.5×` editor wheel
  sensitivity.
- Missing or invalid wheel-sensitivity values fall back to `1.5×` in both the
  client and server.
- Existing users' explicitly persisted sensitivity values remain unchanged.
- Update focused tests for the new defaults.

## Verification

- Run the frontend wheel-sensitivity tests.
- Run the relevant Go settings and migration tests.
- Run `go test ./...` and `git diff --check`.

## Implementation summary

- Changed the shared client and server fallback wheel sensitivity from `1×`
  to `1.5×` for both terminal and editor scrolling.
- Initialized the settings UI from the shared client default.
- Kept all valid persisted values unchanged, including existing `1×` values.
- Added focused coverage for frontend normalization and new-user store defaults.
- Passed the wheel-sensitivity tests, JavaScript syntax check, focused settings
  tests, `go test ./...`, and `git diff --check`.
