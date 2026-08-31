# Task 079: Run the release pipeline only for tags

Status: complete

Change the GitHub Actions release workflow so it runs only when a `v*` tag is
pushed.

- Remove the `main` branch push trigger.
- Preserve the existing tag build matrix and tag-gated release behavior.
- Validate the resulting workflow structure.

Removed the `main` branch filter from the workflow's push trigger. The
pipeline now starts only for pushed `v*` tags. The existing cross-platform
build matrix and the release job's explicit tag guard are unchanged.

Validation:

- Confirmed the workflow has one push trigger containing only the `v*` tag
  filter.
- Confirmed the release job still requires all build jobs and checks that the
  ref starts with `refs/tags/v`.
