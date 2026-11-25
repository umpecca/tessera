# Task 295: Recover Unicode parse speed lost with Kitty graphics

Status: complete (2026-11-25).

## Request

The user asked for performance enhancements; a browser benchmark against
v1.16.3 found Unicode-heavy output parsing about 5% slower. The user chose to
investigate it ("lets start with #1"), then approved the fix ("yes go ahead").

## Findings

- Core-level benchmark (Node, 160x60, `\x1b[32mÅÉgyp 界 é देवनागरी\x1b[0m output\r\n` x128,
  2000 writes, medians): v1.16.3 268 ms, add0295 (tasks 279-292) 268 ms,
  current 281 ms (+4.8%).
- Variant builds from pristine sources (add0295 rebuilt byte-identical):
  Ghostty's `kitty_graphics` switch alone +0.7-1.2% (565 KB); Tessera's APC
  fields without calling Kitty +0.1%; with the `kittyGraphics` call +4.5-5%
  (732 KB). Removing Ghostty's Kitty checks from print/linefeed changed
  nothing. The live Kitty and PNG code changes ReleaseSmall inlining.
- CPU profiles (named builds): style comparison and hashing in the style set
  (`Style.Color.eql`, the set context's `eql`/`hash`) and the SGR parser step
  stop being inlined.

## Scope

- `scripts/patch-terminal-core.mjs`: `@call(.always_inline, ...)` at three
  Ghostty call sites: `Style.eql`'s colour comparisons and the style set
  context's `hash`/`eql` (`src/terminal/style.zig`), the set's `ctx.hash` /
  `ctx.eql` calls (`src/terminal/ref_counted_set.zig`), and `sgr.Parser.next`
  in the SGR loop (`src/terminal/stream.zig`). No behaviour change.
- `scripts/benchmark-terminal-core.mjs`: a Unicode parse line, so the next
  inlining shift shows up.
- Rebuild the core and web bundle; the core ID changes (open tabs reload once).
- Approval: the user said "yes go ahead" to this fix.

## Acceptance criteria

- [x] Unicode parse within about 1-2% of v1.16.3 at the core level (was +4.8%).
- [x] Bundled core matches a clean source build (`--check`); all tests pass.
- [x] Browser benchmark (parse group) no longer shows the Unicode gap.
- [x] CHANGELOG: no entry. The slowdown and Kitty graphics are both unreleased,
      so the last release saw no change; docs updated instead.

## Verification

- `ZIG=$(brew --prefix zig@0.15)/bin/zig npm run build:terminal-core`: core
  `c31c6c9ee5fa1556efb1470e83652bfc55ccc419c722d5149aca83f67831db14`
  (752,766 bytes, +3.7 KB), byte-identical to the scratch variant measured;
  `--check` matches.
- Scratch core benchmark (Node, interleaved, 11 rounds, medians), v1.16.3 /
  before / after: Unicode 268 / 280 / 271 ms (+4.6% -> +1.3%); ASCII with
  colours 184 / 187 / 188; wide 72 / 71 / 72; combining 696 / 719 / 716
  (combining varies by 2-3% between runs).
- Browser parse benchmark (`scripts/benchmark-terminal-browser.mjs
  --group=parse --baseline=<v1.16.3 terminal.js> --repeats=5`, headless
  Chromium 158): Unicode 528.4 -> 533.1 ms (+0.9%; was +5% before the fix),
  build 171.2 -> 169.7, progress 72.4 -> 66.6 (noisy).
- `node scripts/benchmark-terminal-core.mjs --compare=<core>`: prints the new
  Unicode line for both cores (5 samples, sequential, so noisier than the
  scratch harness). The upstream npm core faults on this workload at 160x60,
  so the line is only in the Tessera comparison section.
- `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1178/1178.
  `go test ./...`: pass. `go vet ./internal/terminalcore/ ./internal/terminal/ ./web/`:
  clean. `npm run build:web`: succeeded.

## Implementation notes

- `scripts/patch-terminal-core.mjs` (last step): `style.zig` (`Style.eql`'s
  colour comparisons, the set context's `hash`/`eql`), `ref_counted_set.zig`
  (`ctx.eql` twice, `ctx.hash` twice), `stream.zig` (`sgr.Parser.next`).
- `scripts/benchmark-terminal-core.mjs`: Unicode line per Tessera core.
- `docs/terminal-core.md`: the benchmark paragraph explains the inlining.
- The remaining ~1% matches turning on Ghostty's `kitty_graphics` alone.
  Inlining can shift again with future core changes; rerun the benchmark.
- The core ID changed: open tabs reload once (as already noted for the
  unreleased Kitty entry).
- Scratch variant builds and profiles are in the session scratchpad
  (`bench/`), not kept in the repo.
