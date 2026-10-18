# Task 197: Unsigned .ipa for sideloading

Status: complete (SideStore install on the iPad pending)

## Request

Install the native app (task 196) on the iPad over the VPN. Xcode finds
devices with Bonjour, which Tailscale doesn't carry, so Xcode installs need a
cable or the same Wi‑Fi. SideStore and AltStore can install on the iPad
itself instead, signing with the free Apple ID; they take an unsigned
`.ipa`. The user asked for a script that builds one.

## Changes

- `apple/build-ipa.sh`: a Release build for `generic/platform=iOS` with
  `CODE_SIGNING_ALLOWED=NO` in a temporary derived-data folder (removed on
  exit), zipped as `Payload/Tessera.app` into `apple/build/Tessera.ipa` or
  `--output PATH`. Uses `/Applications/Xcode.app` when `xcode-select` points
  at the Command Line Tools and `DEVELOPER_DIR` is unset. Can be sourced
  without running, like `scripts/install-ubuntu.sh`.
- `.gitignore`: `/apple/build/`.
- `apple/README.md`: installing without Xcode, and the trade-offs (a cable
  once; the sideloading app's VPN replaces Tailscale while it installs; three
  apps on a free Apple ID).

## Validation

- `--help`, an unknown option and `--output` without a path: usage, exit 2.
- A build from a clean state: about 7 seconds; the `.ipa` holds
  `Payload/Tessera.app` with an arm64 executable, `com.jaxdad.tessera`,
  platform `iphoneos`, minimum iPadOS 18.0, device family 2 (iPad), and no
  code signature. The temporary folder is gone afterwards.
- Not yet tried: installing it with SideStore or AltStore.
