# Terminal and RDP performance acceptance

One hands-on testing block for [task 254](../tasks/254-rdp-presentation-backpressure.md),
[task 255](../tasks/255-terminal-smooth-scroll-cache.md),
[task 256](../tasks/256-rdp-payload-copy-reduction.md) and
[task 257](../tasks/257-rdp-bitmap-compression.md). Automated checks are
recorded in those tasks; the boxes below remain manual acceptance, not claimed
results. Use a build containing all changes and reload the browser/app first.

Record device/OS, browser/app version, server, terminal font/size, browser zoom,
performance profile, RDP resolution and full-color setting. Do not include
passwords, private screen content or unredacted credentials in shared evidence.

## 1. Terminal scrollback

Use a large terminal and a normal smaller one. On a host with Python 3, this
creates repeatable history without changing files:

```sh
python3 - <<'PY'
for row in range(2000):
    print(f"\033[32m{row:04d}\033[0m ASCII output 0123456789 abcdefghijklmnopqrstuvwxyz")
for row in range(500):
    print(f"{row:04d} Unicode: Å 界 e\u0301 नमस्ते ┌─┐ █ ░")
PY
```

- [ ] Scroll slowly, fling quickly, reverse direction, and stop between rows.
  Check the partial top row and bottom edge for missing ink, stale strips,
  duplicated text or smearing. Check both ASCII and Unicode history.
- [ ] Reach the oldest history and return to the live prompt. Cursor/blinking,
  typing, scrollbar position and scrollbar fade should remain correct.
- [ ] While stopped between rows, select and copy text, hover/click a URL using
  the usual modifier, search for a line, then clear selection/search/hover.
  Highlights and hit testing must follow the displayed rows.
- [ ] Change font/size, Tight/Comfortable row spacing, terminal colors, pane size,
  browser zoom and performance profile while reading history. Check that the
  first frame after each change is fresh, not old cached pixels.
- [ ] Repeat in Stable and Experimental rendering. Also check a fractional-scale
  configuration. Unsupported grids intentionally use the existing full renderer;
  they are correctness checks, not expected cache-speedup cases.
- [ ] Display a known Sixel fixture and scroll past it in both directions.
  Images and discarded-image markers must stay aligned. Image-containing
  terminals intentionally do not use the text-scroll cache.
- [ ] Minimize/cover/reveal the pane, background/foreground the tab/app, and
  reload/reconnect. Text, images and scroll behavior must recover without ghost
  pixels. Confirm reduced-motion/no-animation preferences still work.

For output while reading history, run this in another terminal or start it before
scrolling up in its pane. Stop it with Ctrl+C when done:

```sh
python3 -u - <<'PY'
import time
for row in range(1200):
    print(row, "live output", flush=True)
    time.sleep(0.05)
PY
```

- [ ] History stays anchored as output arrives; typing returns to live output.
  No old cached rows reappear, including when the scrollback limit is reached.

## 2. RDP presentation pressure

Use an existing trusted test desktop. Start with a kept session and click its
H.264 badge to show stats. Repeat with full color off and on when the server
sends AVC444. Its main and auxiliary views count as separate pictures.

- [ ] Drag/resize remote windows, scroll text/web content and play moving content.
  Check that text and colored edges remain correct, including after remote
  resolution changes. `compositing` may rise transiently but should drain.
- [ ] With browser CPU throttling or network throttling where available, create
  pressure. `behind` may appear; video should slow/pause rather than retain an
  ever-growing queue. Remove throttling and confirm it resumes with fresh pixels.
- [ ] Combine slow CPU with slow network. Removing one bottleneck alone must not
  resume video while the other remains backed up.
- [ ] Minimize/cover the RDP pane or background the app while behind. Catching up
  must not resume hidden video. Reveal it and confirm a complete fresh desktop.
- [ ] If hard overflow or a five-second no-progress timeout occurs, confirm that
  the kept view reattaches without ending the host session or losing remote work.
  Repeated automatic reattachments under normal load are a failure to investigate.
- [ ] Open the same kept desktop in another browser. The replacement should work
  normally, without inheriting stale pressure from the old viewer.
- [ ] Check an in-page (not kept) session too. Normal playback should work; a hard
  overflow/stall must show an explicit Connect/disable-full-color message rather
  than leave a permanently frozen but apparently connected canvas.

### Kept-RDP payload copies and bitmap fallback

- [ ] In a kept bitmap-only session where the server/browser supports one, check
  solid red/green/blue areas, dark backgrounds, text and partial updates at the
  screen edges. No transparent holes, changed colors or stale rectangles should
  appear. Keep TLS and authentication enabled; do not weaken security to force
  bitmap mode. Record this case as untested if no suitable server is available.
- [ ] Repeat full-screen refresh, remote resolution changes and rapid window
  movement at 1080p and a larger resolution where practical. Check both bitmap
  fallback and H.264/AVC444, including after a slow connection catches up.
- [ ] Detach/rejoin and take over from another browser during activity. Queued
  pictures and surface mappings must not turn into later frames or display
  corrupted tiles. Existing pressure/visibility behavior must remain unchanged.

Copy reduction changes allocation and memory traffic, not wire bytes, compression
or expected network bandwidth. Chromium/desktop-WebKit synthetic bitmap checks
do not replace these real-server/iPad checks.

### Kept-RDP bitmap compression

- [ ] Where browser tools expose it, confirm the kept-view WebSocket negotiates
  `permessage-deflate`. Compression is optional; a connection without it must
  still display correctly. Do not disable TLS/authentication for this check.
- [ ] In an available bitmap-fallback session, compare text/flat desktop activity
  with photographs or moving/noisy content, including 1080p and a larger desktop
  where practical. Check actual network bytes, host CPU and responsiveness on
  both a fast and a constrained network. The bounded sampler should skip
  noise-like updates, but mixed content can still compress at extra CPU cost.
- [ ] Check H.264/AVC444 activity before and after bitmap updates: no new stalls,
  corrupted colors or changed input/pressure behavior. H.264 and controls are
  never compressed, even immediately after a compressed bitmap.
- [ ] Repeat detach/reattach, takeover, background/foreground and resolution changes
  with compression negotiated on desktop and iPad Safari/native WKWebView.

The **from host** counter measures inflated application bytes, not wire bytes.
Use network-level measurements to assess bandwidth savings; tools showing
decoded WebSocket payload lengths can also hide compression. Record bitmap
acceptance as untested if no suitable trusted server is available. No whole-session
speedup is implied by synthetic text-compression ratios.

## 3. Combined workload and device recovery

- [ ] Keep RDP motion visible while scrolling a large terminal and generating
  output in two or more other terminals. Type in the active terminal and move
  between panes. Check responsiveness, fairness and visible drawing correctness.
- [ ] Repeat on iPad Safari and the native WKWebView app where used: touch scroll,
  keyboard input, app switching, lock/unlock and foreground recovery.
- [ ] Over a longer session, minimize and restore several terminal/RDP panes.
  Check for steadily increasing memory, accumulating latency, overheating or
  repeat recovery loops. A scroll backing is at most 32 MiB per eligible pane
  and is released when hidden/disposed; decoded RDP pixel memory is not measured
  by the encoded-payload byte counter.

## 4. Foreground text focus (task 261)

- [ ] With a hardware keyboard, leave and return to the updated native iPad app
  and the Home Screen web app. Type into the current foreground terminal without
  clicking it first; repeat with an available remote-desktop/browser pane.
- [ ] Repeat with Settings, a terminal find field, a native sheet or the privacy
  lock open. Returning must not redirect text into the terminal behind that UI.
- [ ] Check Stage Manager/Split View, rapid app switching, device unlock and a
  reconnect. No unintended pane raise, shell resize or synthetic input should occur.
- [ ] Phone Scroll/Select/compose modes stay non-typing. Software-keyboard display
  may still need a tap; record this separately from hardware/DOM keyboard focus.

Native simulator protocol/typing tests and desktop browser lifecycle simulations
do not establish physical-iPad or installed-Home-Screen keyboard acceptance.

## 5. Remembered RDP certificate trust (task 263)

- [ ] On a trusted test RDP host, verify and accept its fingerprint once. Cancel
  the credentials dialog, then reconnect: the same certificate should not prompt
  again. Repeat after reloading and opening a new RDP window/session in Safari and
  the native app using the same Tessera account.
- [ ] Restart the updated test server when approved, retaining its database. The
  accepted fingerprint should still be remembered. Another Tessera account and
  another target/port must not inherit that approval.
- [ ] Where a controlled certificate rotation is available, change the test
  server's certificate without changing its address. Both clients must warn
  before asking for credentials. Cancel first, then verify and explicitly approve
  the new fingerprint. Never rotate a production certificate just for this test.
- [ ] Confirm ordinary kept/in-page login and reconnect still work. A fingerprint
  changed between approval and the actual connection must be rejected, not silently
  learned. Record unavailable rotation/connection-mode cases as untested.

Automated checks use controlled X.224/TLS servers and desktop browsers; they do
not establish real RDP login/graphics or physical-iPad results.

## Results

- Date/build/device/browser:
- Configurations tested:
- Passed sections:
- Failures (reproduction, settings, stats and redacted screenshot if useful):
- Remaining untested cases:

These tests establish real-device acceptance only when actually performed. The
headless browser benchmark is a component measurement, not proof of iPad battery,
hardware presentation latency or whole-application speedup.

## Glyph-cache investigation (task 258)

[Task 258](../tasks/258-terminal-glyph-cache.md) evaluates glyph-atlas prototypes;
the trial was rejected, so it does not enable a new cache in this build.
Transparent sprites changed antialiasing pixels and made Chromium painting
slower; restricted opaque sprites had no consistent cross-browser benefit.
The reproducible tool is
`scripts/benchmark-terminal-glyphs.mjs` (requires Playwright). It compares current
Stable/Experimental terminal rendering with transparent and restricted opaque
sprites, recording cold/warm timings and exact pixel differences. Readback is
outside timing; its local prototypes are not imported by the app.

- [ ] During the existing device testing block, note terminal paint time during
  normal typing, sustained output and large TUI redraws in both renderer modes.
  Record cold behavior after font/scale changes as well as steady state. These
  observations can establish whether another text-rendering optimization is
  justified on the actual iPad; no glyph-cache speedup is assumed.
