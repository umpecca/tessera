# Task 271: Let terminal programs copy to the iPad clipboard in the native app

Status: implemented and automated checks pass (2026-11-13); physical-iPad
acceptance pending.

## Request

In the native iPad app over plain HTTP, copying from a terminal program
(OSC 52: Vim, Helix, tmux, Claude Code) reports "Clipboard blocked". The user
expected the native app's clipboard to work regardless of HTTP.

## Cause

- Task 250 disabled terminal-initiated (OSC 52) writes through the native
  bridge: `writeClipboardText` in `web/clipboard-access.mjs` skips the native
  bridge when `terminal: true`, and `apple/Tessera/NativeClipboard.swift`
  rejects `terminal: true` writes. The concern was a program, possibly on a
  remote SSH host, silently replacing the iPad clipboard at any time.
- The fallback is `navigator.clipboard.writeText`, which WebKit provides only
  in secure contexts. Over HTTPS it succeeds, so OSC 52 works there; over HTTP
  it is absent, the hidden-field copy fails without a user gesture, and the text
  only reaches Tessera's own clipboard.
- So the app is stricter than Safari over HTTPS, which already accepts OSC 52
  writes from any pane (`docs/terminal.md`).

## Scope

- In the native iPad app, OSC 52 text writes go through the native bridge
  when all of these hold:
  - the writing terminal is the active pane, not minimized and on screen (in
    phone view, the open terminal);
  - the page is visible and has focus, and the app is not suspended
    (`browserInUse()`);
  - the bridge's existing checks pass: Tessera's own top-level page on the
    selected server, app in the foreground, privacy lock open, text at most
    1 MiB.
- Writes that fail those conditions (a background, hidden or covered pane, or
  a backgrounded app) do not reach the iPad clipboard. They update Tessera's
  own clipboard as today, and the status line says the copy came from a window
  that wasn't in view.
- Terminal programs still can never read the clipboard (OSC 52 reads stay
  unanswered), and native reads keep their confirmation.
- The terminal pane is passed from `web/terminal-view.mjs` into
  `applyTerminalClipboardWrite` so the web side can check it.
- `NativeClipboard.swift` accepts `terminal: true` text writes; image writes
  and reads are unchanged.
- Unchanged: Safari and other browsers (HTTPS or HTTP), the Firefox extension
  path, the Mac app, and user-initiated copy and paste.
- Docs: `apple/README.md` (replace the "OSC 52 native writes are disabled"
  note), the OSC 52 paragraph in `docs/terminal.md`, `CHANGELOG.md`.
- Approval: the user approved this scope as written ("yes", 2026-11-13).

## Acceptance criteria

- [ ] In the iPad app over HTTP, an OSC 52 copy from the terminal in view
  reaches the iPad clipboard without a "Clipboard blocked" message.
- [ ] An OSC 52 copy from a minimized, hidden, covered or inactive pane, or
  while the app is backgrounded or locked, does not reach the iPad clipboard
  and is reported as coming from a window not in view.
- [x] Clipboard reads by terminal programs remain impossible; user-initiated
  copy and paste and browser behavior are unchanged.
- [x] Automated tests cover the gating; physical-iPad acceptance is recorded
  separately.

## Verification

- `node --test` for `web/clipboard-access` and terminal-view clipboard tests
  (native bridge used only for the pane in view; fallback and message
  otherwise; non-native browsers unchanged).
- `swift test --package-path apple/TesseraCore`; iPad simulator UI suite if a
  bridge test fits there; iPad Release build.
- Manual on a physical iPad over HTTP: `printf '\e]52;c;%s\a' "$(printf hello |
  base64)"` in the active terminal pastes "hello" elsewhere on the iPad; the
  same from a minimized pane via `sleep 5; printf …` does not.

Results, 2026-11-13:

- `node --test web/native-clipboard.test.mjs web/native-app.test.mjs`: 30/30
  passed, including new tests: in-view copy goes to the native bridge with
  `terminal: true`; a copy from a window not in view reaches neither the
  native bridge nor the browser clipboard, keeps Tessera's own Paste and says
  why; a refused native write reports only "Copy failed"; an app without the
  capability keeps the browser fallback; `terminalInView` for active,
  inactive, phone-view, unseen and not-in-use cases.
- `node --test web/*.test.mjs`: 1064/1064 passed.
- `swift test --package-path apple/TesseraCore` (with Xcode's
  `DEVELOPER_DIR`): 34 tests in 6 suites passed.
- iPad Release build, unsigned (`xcodebuild -scheme Tessera-iPad -destination
  'generic/platform=iOS' -configuration Release CODE_SIGNING_ALLOWED=NO`):
  succeeded. Not installed on a device.
- `git diff --check`: passed.
- Not done: the physical-iPad check above. It needs the rebuilt app installed
  on the iPad and a server serving the updated `web/` (the test instance on
  7343 serves it from disk).

## Implementation notes

- `web/terminal-view.mjs`: `terminalInView(rect)` = `browserInUse()` and not
  `paneUnseen(rect)` (hidden page, minimized, covered, or not the phone view's
  open terminal) and, outside the phone view, the active pane. The OSC 52
  callback passes it, evaluated when the copy arrives, to
  `applyTerminalClipboardWrite`.
- `web/clipboard-access.mjs`: `writeClipboardText(text, { terminal, inView })`
  sends a terminal write to the native bridge only when the app reports
  terminal writes and the terminal is in view; otherwise, with that app, it
  returns false without browser fallbacks. Status messages distinguish a
  window not in view from a browser refusal; a failed native write keeps its
  own "Copy failed" message.
- `web/clipboard-bridge.mjs`: `NativeClipboardBridge.check()` reports the app's
  `terminal` capability; `writeText(text, true)` sends `terminal: true`.
- `apple/Tessera/NativeClipboard.swift`: `hello` reports `terminal: true`;
  `writeText` accepts terminal writes (the existing origin, main-frame,
  foreground and privacy-lock checks still apply); `writeImage` still refuses
  them.
- An older app (hello without `terminal: true`) keeps the previous behavior
  with a newer server, and a newer app with an older server never receives
  terminal writes.
- Docs: `apple/README.md`, `docs/terminal.md`, `CHANGELOG.md`.
