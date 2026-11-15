# Task 275: Terminal audio enabled by default

Status: implemented, awaiting device check (2026-11-15).

## Request

In the iPadOS app and the web app, terminal audio should default to enabled
instead of requiring **Enable terminal audio** (menu or badge) first.

Today `TerminalAudioPlayer.enabled` starts `false` and nothing enables it until
a user chooses the menu item or taps the badge. The iPad/Mac app web view
already sets `mediaTypesRequiringUserActionForPlayback = []`, so playback could
start without a gesture there, but the page never tries.

## Scope

- On page start, the web app tries to enable terminal audio without showing an
  error badge if that fails.
  - The iPad/Mac app web view allows this, so audio is enabled immediately.
  - Browsers that block an AudioContext without a gesture (Safari, Chrome without
    media engagement) get audio enabled on the first pointer or key interaction
    anywhere on the page, so the user no longer has to find the enable action. A clip
    that arrives before any interaction still shows the existing badge.
- **Disable terminal audio** is remembered in this browser (localStorage); while it is
  set, the page does not enable audio automatically. **Enable terminal audio** clears
  it. Per-pane mute stays as it is.
- Update `docs/terminal-audio.md`, `apple/README.md` if needed, and `CHANGELOG.md`.
- No Go/server or protocol changes. No native iPad setting.
- Approval: the user replied to the proposal by confirming the iPad app still
  needed the enable tap (2026-11-15); taken as approval to proceed with this scope,
  including remembering Disable.

## Acceptance criteria

- [x] With no saved preference, a new page enables audio at startup when the context
      can resume (the app web view), with no badge.
- [x] When startup resume is blocked, the first pointerdown/keydown on the page enables
      audio, and the listeners are then removed.
- [x] A failed automatic attempt does not show the "Audio could not start" badge.
- [x] Disabling through the menu persists and stops automatic enabling on reload;
      enabling through the menu or badge clears the saved choice.
- [x] Existing terminal audio tests still pass.

## Verification

- `node --test web/terminal-audio.test.mjs web/terminal-audio-stream.test.mjs`:
  21 pass (3 new player tests: immediate enable, quiet wait for gesture, disable
  disarms).
- `node --test web/terminal-audio-default.test.mjs` (new): 3 pass (default on,
  remembered Disable until Enable, blocked storage still defaults on).
- `node --test web/*.test.mjs`: 1070 pass, 0 fail.
- `npm run build:web`: exit 0.
- All automated with mocked AudioContext/window. Not yet performed: the iPad app
  and a real browser playing a clip without the enable step.

## Implementation notes

- `web/terminal-audio.mjs`: `enableByDefault(target)` tries a quiet `enable()`
  now and on pointerdown/pointerup/touchend/click/keydown (capture) until one
  succeeds; success or `disable()` removes the listeners. `enable({ quiet })`
  skips the "Audio could not start" badge.
- `web/terminal-view.mjs`: `enableTerminalAudio`/`disableTerminalAudio` save the
  choice under `tessera.terminal-audio.disabled.v1`; startup and a
  back/forward-cache `pageshow` call `enableTerminalAudioByDefault`. The badge and
  the terminal menu (`web/workspace-menus.mjs`) use these.
- The app web view already sets `mediaTypesRequiringUserActionForPlayback = []`,
  so no Swift change; the iPad app picks this up once its server runs a build with
  the new web assets.
- Docs: `docs/terminal-audio.md`, `CHANGELOG.md`. `apple/README.md` already says
  the app plays audio without a first tap, which is now accurate.
