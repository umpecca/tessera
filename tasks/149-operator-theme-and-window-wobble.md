# Operator theme and gentle window wobble

Status: complete

## Request

Build the agreed Operator mockup as a selectable Tessera theme. Keep movable,
resizable panes, use 32px desktop title bars with titles rather than numbers,
add minimize/maximize/restore/close controls, a subtle grip, and a softly lit
active window. Terminal content has no persistent folder or connection bar.
Add optional gentle whole-window elasticity while dragging and a short settle
on release, without changing saved geometry or terminal dimensions.

## Constraints

- Preserve the existing themes, terminal palette preferences, window menus,
  rename feature, shortcuts, docking, minimizing, and session persistence.
- Keep restore controls available on maximized Operator windows.
- Wobble is local to this browser and to the dragged Operator window. Disable
  it for reduced motion and Older Mac mode; stop on cancellation, hiding,
  destruction, resizing, theme change, or opting out.
- Use a bounded spring animation without continuous work on idle windows.
- Confirm ending a live terminal from the new close button.

## Validation

- Eleven new spring and integration regressions cover bounded movement,
  frame coalescing, idle/release settling, cancellations and preference changes,
  unchanged translation/size, theme refitting, titles, close confirmation,
  docking and fullscreen origin. A twelfth protects Cascade Arrange insets.
- Real Chromium checks cover dragging from the grip, fixed terminal canvas
  dimensions during drag, settling, minimize/restore, maximize controls,
  title renaming, theme persistence, browser opt-out, reduced motion, Older Mac
  mode, close confirmation and accepting shell closure. Touch checks validate
  48px title bars, 44px controls, and visible fullscreen origin at 390px wide.
- All JavaScript/core tests, Go tests, Go vet, syntax and diff checks, and the
  embedded Windows host build pass. Browser screenshots and the reproducible
  UI check are in the ignored `.cache/review/operator-149` directory.

## Implementation

Operator keeps the existing pane system and user-selected terminal palette.
Its title bar lives inside the pane's stored box, allowing docking at the
desktop edge and keeping maximize/restore/close accessible in fullscreen.
New Operator panes use unsuffixed titles; saved/custom titles are untouched.
The new close button is hidden in other themes.

Wobble uses bounded spring-driven rotate/scale properties around the grabbed
point. It is a gentle whole-window approximation, rather than an independently
deforming Compiz mesh. Translation and dimensions remain owned by existing
geometry code, with no terminal refit during movement. Animation work stops
once the spring settles, including when the pointer pauses during a drag.

Select **Settings → Theme → Current → Operator**. **Wobbly windows** is On by
default for this theme and can be disabled per browser. No database migration,
terminal renderer rebuild, or change to existing pane contents is required.
