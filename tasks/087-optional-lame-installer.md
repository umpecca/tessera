# Task 087: Optional LAME companion installation

Status: complete

Let the Ubuntu service installer optionally install Tessera's pinned LAME
encoder companion alongside the main executable.

## Requirements

- Add `--with-lame` and `--without-lame` installer options and reject unknown
  arguments with a concise usage message.
- When neither option is supplied in an interactive terminal, ask whether to
  install the optional LAME encoder, defaulting to no.
- Keep non-interactive installs deterministic and backward-compatible by
  defaulting to no when neither option is supplied.
- Download the matching `tessera-lame-linux-amd64` or
  `tessera-lame-linux-arm64` asset from the same latest GitHub Release used for
  Tessera.
- Download and validate every selected asset before replacing installed files.
- Install the companion root-owned and executable beside Tessera under its
  exact release asset name so runtime discovery and self-update find it.
- Choosing not to install LAME must not remove an already installed companion.
- Explain that this is the MP3 encoder; Terminal audio capture still requires
  the separately installed capture helper.
- Document interactive and non-interactive examples and report what was
  installed at the end of the script.

## Verification

- Validate script syntax with `bash -n scripts/install-ubuntu.sh`.
- Exercise argument parsing, interactive defaults, architecture-specific asset
  selection, staged downloads, and the no-removal behavior with mocked shell
  commands where practical.
- Run `git diff --check`.

## Implementation

- `--with-lame` and `--without-lame` select the optional companion explicitly;
  interactive installs prompt with a no default and non-interactive installs
  skip it unless requested.
- The selected architecture's Tessera and LAME assets are both downloaded and
  checked before either installed file is replaced. The companion keeps its
  exact release name beside Tessera for runtime and updater discovery.
- A sourceable helper boundary supports mock tests for argument conflicts,
  prompt defaults, architecture aliases, and the exact release asset URL.
- The tag workflow runs syntax validation and the mock installer tests before a
  GitHub Release can be published.

Verification completed with Git for Windows Bash:

- `bash -n scripts/install-ubuntu.sh`
- `bash -n scripts/install-ubuntu.test.sh`
- `bash scripts/install-ubuntu.test.sh`
