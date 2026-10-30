# Task 245: Linux, macOS and Windows test platforms

Status: paused (2026-10-30), not started. Scoped only.

## Request

Stand up Linux, macOS and Windows test platforms before taking on bigger
work, starting with task 244 (sign in as yourself). Its phase 0 is done on
macOS, but its Linux checks are still open because no Linux machine is
available ("Spike results" in tasks/244-sign-in-as-yourself.md).

## Findings (2026-10-30)

- **This Mac:** an Apple M4 with 10 cores and 16 GB of memory, on macOS
  27.0.1, with Homebrew installed. No virtualization tools are installed:
  no QEMU, UTM, Tart, Docker, Lima or Multipass.
- **Disk space:**
  - The boot disk has only about 2 GB free (87% used), which is a problem
    for macOS itself, apart from any VMs.
  - `/Volumes/Data` has 1.8 TB free. All VM images and disks go there.
- **What's available:** no Linux VM or VPS. A real Windows machine may be
  available (to confirm).

## Proposal

Local virtual machines on this Mac, with no cloud cost.

| Platform | Tool | Memory | Notes |
| --- | --- | --- | --- |
| Linux (Ubuntu Server, arm64) | Tart | 2–4 GB | Apple's Virtualization framework; boots in seconds |
| macOS (a clean VM) | Tart | 4–6 GB | Apple's license allows macOS VMs on Apple hardware. For fresh installs, LaunchDaemons and second accounts, away from the real Mac |
| Windows 11 (arm64) | UTM | 4–6 GB | Free, and emulates x64 apps when needed. Tessera builds for `windows/arm64`. Unactivated is fine for testing |

- **Installation:** `brew install cirruslabs/cli/tart utm`, with Tart's
  storage (`TART_HOME`) and UTM's VMs on `/Volumes/Data/vms`.
- **Memory:** with 16 GB, run one or two VMs at a time, not all three.
- **A real Windows machine** reachable over SSH could stand in for the
  Windows VM, or sit alongside it.

### What each VM provides

- Test accounts with known passwords: a main one and a second one, for
  cross-account tests.
- SSH from this Mac, and passwordless `sudo`. Tests that need root or a
  second account's password can then run without anyone typing passwords.
- A Tessera built here (cross-compiled), copied in and run there. Browser
  tests (Playwright) then run from this Mac against the VM's Tessera.

### What it unlocks

- **Task 244:**
  - the remaining Linux checks (`chkspike`, a cross-account `ptyspike` run,
    and xrdp),
  - later, the root helper and service install on Linux and macOS,
  - Windows, its phase 5.
- **Installer and service checks:** `scripts/install-ubuntu.sh`, a macOS
  LaunchDaemon, and a Windows service.
- **The Screen pane** (VISION.md, roadmap item 5): RDP from Windows into
  itself, which is listed there as needing checking early, and xrdp on
  Linux.
- **Any platform-specific change**, tried on the platform it is for.

## Plan

1. Install Tart and UTM, with storage on `/Volumes/Data/vms`.
2. **Linux:**
   - Pull an Ubuntu Server image.
   - Create the test accounts, SSH and `sudo`.
   - Check that Tessera runs.
   - Then finish task 244's Linux checks.
3. **macOS:** the same, from one of Tart's prebuilt macOS images.
4. **Windows:** download a Windows 11 arm64 installer and set it up in UTM.
   A few setup steps need someone at the screen. Then SSH (OpenSSH Server),
   test accounts, and a Tessera build.
5. A short guide in docs/development.md: starting, stopping and resetting
   each VM, and running Tessera and the tests against it.

## Open questions

- Is there a real Windows machine to use instead of a VM, or as well?
- Should VM disks be kept between uses, or reset to a clean snapshot for
  each test run? Both, probably: a clean base image, and a working copy
  made from it.
- Free up the boot disk first? With 2 GB free, Homebrew installs and
  macOS updates may fail.
