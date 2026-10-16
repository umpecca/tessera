# Task 183: Only tags trigger CI

Status: complete

The user requested that only tags trigger CI/CD, then asked to keep the
artifact cleanup workflow as it was.

- CI and Release runs only on pushed `v*` tags. Its `main` push, pull request
  and manual-dispatch triggers are removed. The release job already required a
  `v*` tag push, so publishing is unchanged.
- The Desktop macOS preview workflow was briefly moved to tag-only, then removed
  with the app in task 184.
- Cleanup old artifacts keeps its daily schedule and manual dispatch.
- README and CHANGELOG describe the triggers.

Consequence: branches and pull requests are no longer tested in CI; the first
CI run for a change is its release tag.

Validation: inspected every workflow's `on:` block and the release job's tag
condition.
