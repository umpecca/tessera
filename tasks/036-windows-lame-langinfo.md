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
- LAME's configure output nevertheless enables `HAVE_LANGINFO_H`, causing the
  later frontend compile to fail at `parse.c:74`.
- Installing or adding `/usr/include` would mix the MSYS POSIX runtime headers
  into a native MinGW build and is not an appropriate fix.

## Change

- In `encoder-windows` only, seed Autoconf's
  `ac_cv_header_langinfo_h=no` cache result before running LAME's configure
  script.
- Pass `--disable-nls` because localized POSIX message handling is unnecessary
  for Tessera's headless PCM-to-MP3 sidecar.
- Assert after configure that `config.h` does not define
  `HAVE_LANGINFO_H`, providing an immediate diagnostic if upstream behavior
  changes.
- Build the existing pinned LAME 3.100 source and run the resulting
  `frontend/lame.exe --version` before publishing it.
- Leave Linux and macOS encoder builds unchanged.

## Verification

- Validate the workflow YAML and inspect the Windows shell commands.
- Run repository tests and `git diff --check`.
- Confirm the next `encoder-windows` GitHub Actions job compiles and executes
  the version smoke check.

## Implementation summary

- Seeded `ac_cv_header_langinfo_h=no` and passed `--disable-nls` only in the
  native MinGW encoder job.
- Added a post-configure assertion that rejects any generated
  `HAVE_LANGINFO_H 1` definition before compilation begins.
- Added `frontend/lame.exe --version` as a pre-publication executable smoke
  check.
- Validated workflow YAML syntax and guard presence, then passed
  `go test ./...`, `go vet ./...`, and `git diff --check`.
