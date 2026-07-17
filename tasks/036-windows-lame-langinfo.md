# Task 036 — Fix Windows LAME langinfo detection

Status: complete

Fix the `encoder-windows` release job failure where LAME 3.100's
`frontend/parse.c` includes unavailable POSIX `langinfo.h` while compiling a
native MinGW-w64 executable under MSYS2.

## Diagnosis

- The job correctly targets native Windows through the MSYS2 `MINGW64`
  environment and `mingw-w64-x86_64-gcc`.
- MinGW-w64 does not supply the MSYS POSIX `langinfo.h` for native Windows
  programs.
- LAME 3.100 includes `langinfo.h` whenever `HAVE_ICONV` is enabled, without
  checking whether the target provides that POSIX header. This is upstream LAME
  bug 487, not an Autoconf `HAVE_LANGINFO_H` decision.
- Installing or adding `/usr/include` would mix the MSYS POSIX runtime headers
  into a native MinGW build and is not an appropriate fix.

## Change

- Vendor the historical MSYS2 patch for LAME 3.100. It removes the unavailable
  header and replaces five `nl_langinfo(CODESET)` calls with codeset parsing
  from the `LANG` environment variable.
- Check out the Tessera repository in `encoder-windows`, install MSYS2's `patch`
  build tool, and apply the repository-owned patch to the pinned archive.
- Pass `--disable-nls` because localized POSIX message handling is unnecessary
  for Tessera's headless PCM-to-MP3 sidecar.
- Assert before configure that neither the include nor the POSIX function calls
  remain in `frontend/parse.c`.
- Build the existing pinned LAME 3.100 source and run the resulting
  `frontend/lame.exe --version` before publishing it.
- Leave Linux and macOS encoder builds unchanged.

## Verification

- Validate the workflow YAML and inspect the Windows shell commands.
- Run repository tests and `git diff --check`.
- Confirm the next `encoder-windows` GitHub Actions job compiles and executes
  the version smoke check.

## Implementation summary

- Replaced the ineffective `HAVE_LANGINFO_H` cache override with the historical
  MSYS2 patch for upstream LAME bug 487.
- Added repository checkout and the MSYS2 `patch` tool to the Windows encoder
  job, then asserted that no `langinfo.h` or `nl_langinfo(CODESET)` reference
  remains.
- Retained `--disable-nls` and `frontend/lame.exe --version` as Windows-only
  configuration and pre-publication checks.
- Applied the committed patch successfully to a freshly downloaded copy of the
  exact pinned LAME 3.100 release archive.
- Repeated that verification with the same GNU `patch` command used by the
  MSYS2 workflow; it patched `frontend/parse.c` cleanly and left no POSIX
  langinfo references.
- Forced LF checkout for repository patch files, validated workflow YAML and
  required steps, and passed `git diff --check`. The prior repository checks
  (`go test ./...` and `go vet ./...`) remain valid because the correction only
  changes release assets and workflow commands.
