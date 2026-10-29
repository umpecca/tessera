# Task 240: RDP on a phone

Status: scoped, not started

## Request

Make an RDP window usable from a phone: open it from the phone view, see the
remote desktop at a readable size, click, right-click, scroll and type with
only a touchscreen. Builds on the phone view (tasks 231, 232) and the RDP pane
(tasks 236–239).

## Findings (2026-10-29, from the code; not yet tried on a phone)

- **The phone view leaves RDP out.** `phoneCards` (`web/phone-view.mjs`) only
  makes cards for terminals; other panes are listed as "open on the desktop
  view". The phone's only way in is switching to the desktop view, where the
  RDP window is an ordinary window on a 390-pixel-wide screen.
- **Touch already reaches the remote side as a mouse.** The canvas handles
  pointer events and has `touch-action: none` (`web/app.js` RDP pane setup,
  `web/styles.css` `.rdp-canvas`). A tap is a left click where the finger
  lands; a drag is a left-button drag.
- **No right-click.** `contextmenu` is suppressed and a touch only ever
  reports button 0.
- **No touch scrolling.** Scrolling comes only from `wheel` events, so a
  finger drag selects or drags on the remote desktop.
- **No zoom or pan.** `touch-action: none` disables the browser's pinch, and
  the pane's own scale modes are Fit, 1:1 and Resize. In Fit a 1920-wide
  desktop on a phone is about 5x too small to hit targets; in Resize a
  portrait phone asks for a tall, narrow desktop, which most remote apps
  handle badly, and a kept session (task 238) would rearrange its windows for
  the desktop browser too.
- **No on-screen keyboard.** Keys come from `keydown`/`keyup` on the canvas,
  and focusing a canvas doesn't raise a phone keyboard. Phone keyboards also
  report `code` as empty or `Unidentified` (Android sends key 229 while
  composing), so `handleRDPKey`'s scancode table can't be used for their text.
- **Unicode input exists on both paths.** IronRDP's `DeviceEvent` has
  `unicodePressed`/`unicodeReleased`, and the kept-session viewer wire has
  `inputRecords.unicode` (`web/rdp-viewer-wire.mjs`). Typed text can be sent
  as characters, independent of the remote keyboard layout.
- **Phone pixel ratio is already handled.** `rdpPixelRatio` caps sharp mode
  at 2x. Remotr's 2x limits (task 239) apply unchanged.
- **The phone keyboard covers the page without shrinking it**; task 232 sizes
  around it with `visualViewport`.

## Decisions (proposed; confirm before building)

1. **The remote desktop keeps a desktop size on a phone.** The phone view
   never sends Resize; it shows a fixed desktop (the pane's current size, or
   1920x1080 for a new connection) and zooms and pans locally. This leaves a
   kept session's layout alone when moving between phone and desktop.
2. **Two touch modes, toggled in the phone RDP toolbar, remembered per
   browser:**
   - **Touch (default):** tap = left click at the finger; long-press (500 ms,
     as `PhoneInput`) = right click; one-finger drag = left drag; two-finger
     drag = scroll; pinch = local zoom; two-finger tap = right click.
   - **Trackpad:** the remote cursor stays on screen and a one-finger drag
     moves it relatively; tap = click at the cursor; two-finger tap = right
     click; two-finger drag = scroll; tap-and-drag = left drag. The view pans
     to keep the cursor visible. This is the precise mode for small targets.
3. **Local zoom and pan are done in the page**, by a CSS transform on the
   canvas, from 1x (whole desktop fits the width) up to 1:1 desktop pixels
   per device pixel. Coordinates map through the transform in one place
   (extend `rdpCanvasPoint`).
4. **Typing goes through a hidden text field**, not the canvas. A Keyboard
   button focuses it, raising the phone keyboard. Its `beforeinput`/`input`
   events send each inserted character as a Unicode press and release;
   deletions send Backspace scancodes; Enter sends the Enter scancode. The
   field is kept empty (with a sentinel character so Backspace still fires)
   so composition and autocorrect don't accumulate.
5. **A key row above the phone keyboard**, as in task 232: Esc, Tab, sticky
   Ctrl, Alt, Win (sticky, so Win alone or with a key), arrows, Delete,
   Ctrl+Alt+Del, and Cmd for a Mac target (Remotr maps Win to Cmd; to verify).
   These send scancodes, since modifiers can't combine with Unicode events.
6. **Toolbar on a phone:** Back, Keyboard, mode toggle, zoom-to-fit,
   overflow menu (Send/Copy clipboard, video mode, Disconnect). The desktop
   toolbar's address field and scale select stay on the desktop view.

## Plan

### Phase 1: RDP in the phone view
- `phoneCards`: RDP panes get cards (title, target, connected or kept state)
  instead of the "other windows" line. VNC and browser panes stay as now.
- Opening one shows the workspace's own RDP pane full screen without its
  window, as terminals do, with saved geometry and scale mode untouched.
- Connecting from the phone (address, sign-in dialog, certificate prompt)
  works at phone width.

### Phase 2: Zoom and pan
- Pinch and two-finger pan on the screen, local only; double-tap toggles fit
  width and 1:1.
- Pointer coordinates go through the zoom transform.

### Phase 3: Touch gestures
- Touch-mode gestures (decision 2) in a small gesture recognizer module
  (`web/rdp-touch.mjs`) that turns pointer events into
  `{ move, press, release, wheel }` actions, so it unit-tests without a
  canvas. Mouse and pen keep today's direct behaviour.
- Two-finger scroll goes through `rdpWheelAmount` so the scroll-speed setting
  applies.
- Trackpad mode and its cursor follow.

### Phase 4: Keyboard
- Hidden field + Unicode sending (decision 4), for both the in-page IronRDP
  session and the kept-session viewer.
- Key row (decision 5), reusing `PhoneInput`'s sticky-modifier handling
  where it fits.
- Layout around the phone keyboard with `visualViewport`, panning the view
  so the remote cursor (or the last tap) stays above the keyboard.

### Phase 5: Device check
- iPhone Safari and an Android Chrome, against Remotr on the Tessera host and
  a Windows target: connect, kept-session attach, tap, right-click, drag,
  scroll, pinch, type (including autocorrect, emoji and a non-ASCII
  character), Ctrl+C/V in a remote app, rotate the phone.
- Check that H.264/AVC444 decoding keeps up on a phone at 1920x1080.

## Open questions

- Is Touch or Trackpad the better default? (Proposed: Touch; Trackpad is one
  tap away.)
- Does Remotr accept Unicode keyboard events, and does it map them correctly
  on macOS? If not, fall back to scancodes for ASCII through a US layout table.
- Should the phone view offer RDP panes only, or VNC too? VNC would reuse the
  gesture and zoom modules but needs its own keyboard path.
