# Terminal helper CI and releases

Status: implemented and locally verified

Build and test tessera-audio and tessera-file with Tessera for Windows amd64,
macOS arm64, and Ubuntu/Linux amd64. x64 and amd64 name the same architecture;
retain the already supported Linux arm64 target as well.

Reuse the release workflow, adding pull-request, main-branch and manual CI runs.
Only version-tag pushes publish releases. Keep separate helper assets, preserve
legacy updater compatibility assets, fail missing artifact uploads, and verify
the complete platform/server/helper asset set before release publication.

Validate workflow syntax, helper tests and all helper cross-builds locally.
Document CI triggers, release names and the external FFmpeg streaming dependency.
No tag, push, workflow dispatch or public release is requested by this task.

Implemented:
- Reused release.yml and its four native platform jobs; main/PR/manual runs now
  build and upload artifacts, while only pushed v* tags publish releases.
- Added Go setup to terminal-core validation and helper vetting to every target.
  Linux arm64 now runs the complete Go suite; matrix failures do not cancel the
  other platforms.
- All artifact uploads fail on absent files. Release publication requires all
  12 nonempty regular server/audio/file binaries, preserving existing verified
  legacy updater assets.
- Documented triggers, platform asset names, installation and FFmpeg dependency.

Verification:
- actionlint passes for release.yml.
- Both helpers cross-build for Windows amd64, macOS arm64, Linux amd64 and arm64
  with CGO disabled: eight fresh binaries in .cache/review/terminal-helpers-175.
- Host helper/protocol tests and go vet pass.
- All 560 JavaScript/core/script/Firefox bridge tests pass, including missing,
  empty and directory artifact rejection and workflow/platform manifest parity.
- Actual GitHub runner execution/publication awaits pushing these changes and
  the next version tag. Local cross-builds do not substitute for macOS/Linux
  runtime testing, which the CI jobs will perform.

Existing tasks 171–174 remain intact. No commit, push or release performed.
