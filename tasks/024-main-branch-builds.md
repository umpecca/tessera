# Task 024: Build main without publishing releases

Status: complete

Run Tessera's cross-platform build workflow for commits pushed to `main`, while
continuing to publish GitHub Releases only for pushed `v*` tags.

- Trigger the workflow for both `main` and `v*` tag pushes.
- Guard the release job explicitly so branch pushes cannot publish.
- Give write access only to the tag-gated release job.
- Keep build artifacts available for successful `main` runs.

Implemented by adding `main` to the push triggers and guarding the release job
with `startsWith(github.ref, 'refs/tags/v')`. Workflow-level repository access
is read-only; only the guarded release job receives `contents: write`.

Verification:

- Confirmed the workflow contains the `main` and `v*` triggers, tag-only job
  guard, and split read/write permissions.
- `npm ci`
- `npm run build:web`
- `go test ./...`
- `git diff --check -- .github/workflows/release.yml tasks/024-main-branch-builds.md`
