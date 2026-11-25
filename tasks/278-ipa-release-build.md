# Task 278: Build the iPadOS .ipa in GitHub Actions releases

Status: implemented; CI run pending the next tag push (2026-11-15).

## Request

Build the unsigned iPadOS `.ipa` in GitHub Actions and attach it to each GitHub
release next to the server binaries.

## Findings

- `apple/build-ipa.sh` already builds an unsigned `Tessera.ipa`
  (`xcodebuild … CODE_SIGNING_ALLOWED=NO`, zip of `Payload/Tessera.app`) for
  SideStore/AltStore, which sign it at install time. No signing secrets needed.
- The app uses iOS 26 APIs and the project was last saved by Xcode 27
  (`LastUpgradeCheck = 2710`); local builds use Xcode 27.2. GitHub's `macos-26`
  image defaults to Xcode 26.x; the separate `xcode-27` runner label (arm64,
  generally available since 2026-10-15) has the Xcode 27 toolchain and SDKs.
- The app loads its page from the server, so the `.ipa` doesn't depend on the
  web asset build.
- The app's version is fixed in the project (`MARKETING_VERSION = 0.2`,
  `CURRENT_PROJECT_VERSION = 5`); release tags are `v1.16.3` style.

## Scope

- `.github/workflows/release.yml`: new `ipa` job on `runs-on: xcode-27` that runs
  `swift test` for `apple/TesseraCore`, then `bash apple/build-ipa.sh --output
  tessera-ipados.ipa`, and uploads it as an artifact. The `release` job needs it,
  downloads it with the binaries and attaches it.
- Stamp the app with the release version: `build-ipa.sh` gains optional
  `--version`/`--build` arguments passed to xcodebuild as `MARKETING_VERSION` /
  `CURRENT_PROJECT_VERSION`. CI passes the tag without `v` (e.g. `1.16.3`) and
  `github.run_number`. Local runs without them keep the project's values.
- `scripts/verify-release-assets.mjs` (+ test) also requires `tessera-ipados.ipa`.
- Docs: `apple/README.md` (download from Releases, then sideload), `CHANGELOG.md`.
- Not in scope: App Store/TestFlight signing, notarization, the Mac app.
- Approval: user approved this scope, the `tessera-ipados.ipa` name and following the server release tag for the app version (2026-11-15).

## Acceptance criteria

- [ ] A `v*` tag push builds `tessera-ipados.ipa` and the release lists it with the
      server binaries.
- [x] The release fails if the `.ipa` is missing or empty.
- [x] The `.ipa`'s `CFBundleShortVersionString` matches the tag (local build; CI pending).
- [x] `bash apple/build-ipa.sh` with no new arguments behaves as before.

## Verification

- `node --test scripts/verify-release-assets.test.mjs`: 4 pass (new test: a
  missing or empty `tessera-ipados.ipa` blocks publication; the workflow builds it
  and `release` needs the `ipa` job).
- Local `bash apple/build-ipa.sh --version 1.16.3 --build 1 --output …/tessera-ipados.ipa`
  (Xcode 27.2): built, 1.5 MB; its Info.plist reads `CFBundleShortVersionString`
  1.16.3 and `CFBundleVersion` 1.
- `--version 1.16.3-rc1` is rejected (exit 2); `bash -n` passes; an empty
  version-settings array expands to nothing under `set -u` in bash 3.2.
- `swift test --package-path apple/TesseraCore`: 37 tests passed.
- Workflow parsed with Ruby YAML: jobs `assets, build, ipa, installer-test,
  release`; `release` needs `build, ipa, installer-test`; `ipa` runs on `xcode-27`.
- Pending: the real GitHub Actions run on the `xcode-27` runner (next `v*` tag),
  which verifies the first acceptance criterion.

## Implementation notes

- `.github/workflows/release.yml`: `ipa` job (checkout, `swift test`,
  `build-ipa.sh --version "${version%%-*}" --build run_number`, upload artifact
  `tessera-ipados`). The release job's existing `tessera-*` download pattern
  picks it up into `dist/`, which `softprops/action-gh-release` attaches.
- A tag suffix such as `-rc1` is dropped, since iPadOS versions are numeric.
- `apple/build-ipa.sh`: `--version`/`--build` set `MARKETING_VERSION` /
  `CURRENT_PROJECT_VERSION` (the Info.plist is generated from them).
- `scripts/verify-release-assets.mjs`: `releaseApps = ["tessera-ipados.ipa"]`.
- Docs: `apple/README.md`, `CHANGELOG.md`.
