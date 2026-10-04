# Safari Control-click terminal selection investigation

Investigated October 2, 2026 against the current Tessera checkout and its pinned
`ghostty-web@0.4.0` dependency. The reported gesture happened in Safari without
holding Shift, in a full-screen terminal pane running Claude Code. The user
subsequently clarified that the triggering gesture was **holding Control while
clicking a hyperlink**, rather than an ordinary unmodified selection drag.

The repair described below is now implemented. The findings about the previous
code are retained to explain the original failure.

## Finding

The strongest explanation is a **Control-click/context-menu conflict that
selects the terminal canvas natively in Safari**, alongside the terminal's own
selection handling.
This remains an inference: the affected Safari tab's DOM state and event trace
were not available, and there was no live Safari reproduction on this Windows
host.

The screenshot has a uniform translucent ochre tint over the canvas, including
empty space, and retains the appearance of the underlying glyphs. The current
terminal's local selection instead uses an opaque `#e5e5e5` background with
black foreground in dark mode, or black background with white foreground in
light mode (`web/terminal-colors.mjs`). Selecting a canvas as a single browser
object would make the whole terminal appear selected without selecting its
individual text cells.

WebKit treats a canvas as a replaced element and paints a selection tint over
that element after painting its content. This supports the visual explanation;
it does not establish which event created the range in the user's Safari build.
Sources: [WebKit canvas renderer](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/rendering/RenderHTMLCanvas.h)
and [replaced-element selection painting](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/rendering/RenderReplaced.cpp).

## The clarified Control-click trigger

On macOS, Control-click invokes a secondary-click context menu
([Apple's documentation](https://support.apple.com/en-us/guide/mac-help/mh35853/mac)).
Tessera's link provider accepts either Control or Command as its activation
modifier (`web/terminal-links.mjs`), while its original link task specifically
describes Command-click for macOS (`tasks/037-terminal-clickable-links.md`).

The previous paths conflicted:

1. `terminalShouldReportMouse()` returns false whenever Control is held,
   regardless of whether the TUI has mouse tracking enabled (`web/app.js:6021`).
2. The pointer-down guard only recognizes a secondary button through
   `event.button === 2`. If Safari supplies a primary-button event with Control
   held, it passes through to Ghostty. Ghostty starts local selection on every
   primary mousedown, including a Control-modified one.
3. The same Control modifier makes `onContextMenu()` skip the existing
   TUI-owned cleanup and instead call `openTerminalMenu()`. That local menu
   path does not end Ghostty's selection gesture or clear a browser range.
4. WebKit's `sendContextMenuEvent()` may select editable content **before** it
   dispatches the DOM `contextmenu` event. It explicitly permits selection for
   that operation and also accounts for the mouse release not arriving while
   a native menu is up. Calling `preventDefault()` from Tessera's menu handler
   therefore does not by itself undo any selection already created.

Source for the selection/event ordering:
[WebKit EventHandler](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/EventHandler.cpp).
The editable canvas, native object tint, and missing range cleanup make this
sequence a much better explanation of the report than an ordinary drag.
The precise button values and release sequence from the affected Safari build
have not been captured; the source-level reproduction deliberately models a
primary-button Control-click followed by a context-menu event.

**Immediate workaround:** use Command-click to activate terminal links on
macOS. Tessera already supports that path. It avoids the Control-click context
menu conflict, although the broader selection defects still require repair.

## How the previous code permitted this

- Ghostty's `Terminal.open()` sets `contenteditable="true"` on the terminal
  container (`node_modules/ghostty-web/dist/ghostty-web.js:2330`).
- `.terminal-container` explicitly uses `user-select: text`; its canvas has no
  native-selection suppression (`web/styles.css:1790`, `:1895`).
- Ghostty briefly focuses a hidden textarea on canvas mousedown, but its
  selection manager then focuses the editable parent. Tessera's own `focus()`
  also targets that parent (`web/terminal-entry.js:84`).
- Tessera has no terminal-scoped `selectionchange`/`selectstart` handling and no
  DOM `Selection.removeAllRanges()` cleanup. Ghostty's `clearSelection()` only
  clears its own cell coordinates.
- The previous macOS repair only runs during a TUI-owned context-menu gesture
  and clears a newly created **Ghostty** selection (`web/app.js:5926`,
  `web/terminal-input.mjs:29`). A primary-button drag or native DOM range falls
  outside that repair.

For an unmodified gesture, Tessera sends input to the running application if
mouse tracking is enabled, or allows Ghostty's local selection otherwise.
For the clarified Control-click gesture, it always chooses the local route:
Claude Code's mouse-tracking state is not needed to explain that branch.
Neither route cleans up a native Safari canvas selection.
Full-screen pane size makes a selected canvas cover nearly the entire view;
there is no evidence that maximizing itself is the initiating bug.

## Additional confirmed defects before repair

**Local selection can remain in drag mode after a missed mouseup.** The pinned
selection manager ends a drag through a document-level `mouseup`. It has no
blur, visibility-change, or pointer-cancellation recovery, and its mousemove
handler ignores `event.buttons`. If the release is lost, later zero-button
movement still changes the selection. A zero-length drag also survives
`clearSelection()` because that method returns before resetting `isSelecting`
when `hasSelection()` is false. These are distinct from Tessera's guarded
mouse-reporting state for the running TUI.

**Selection invalidation does not wake Tessera's render scheduler.** Ghostty's
selection manager has an empty `requestRender()` implementation: upstream
assumes its permanent render loop will notice dirty selection rows. Tessera
replaces that loop with scheduled frames (`web/terminal-entry.js:66`) but does
not connect local selection changes to the scheduler. Changes and clearing can
therefore remain invisible until output, cursor blinking, scrolling, resizing,
or another activity requests a frame. This is particularly relevant with
cursor blinking disabled. It cannot by itself explain a Safari-owned tint.

The current upstream selection source still documents that permanent-loop
assumption: [Ghostty selection manager](https://github.com/coder/ghostty-web/blob/main/lib/selection-manager.ts).
An existing [upstream input/focus proposal](https://github.com/coder/ghostty-web/pull/120)
also removes the editable container, but concerns IME behavior and is not
confirmation of this reported bug.

## Verification performed

The initial isolated experiment extracted the installed selection manager and
exercised its actual handlers with mocked event surfaces, alongside Tessera's
actual `TerminalRenderScheduler`. The maintained regressions now test the
repaired behavior against that same pinned selection manager. Run:

```powershell
node --test web/terminal-selection.test.mjs web/terminal-input.test.mjs
```

The initial experiment confirmed all five defects:

1. A lost mouseup leaves selection active through blur, visibilitychange and
   pointercancel; mousemove with `buttons=0` still changes the endpoint.
2. Clearing a zero-length drag leaves it active.
3. Clearing Ghostty selection never calls the DOM Selection API.
4. Selecting/clearing does not request a scheduled frame; an unrelated frame
   removes the stale painted selection.
5. A primary-button Control-click passes through Tessera's actual bridge to
   Ghostty selection. Its context-menu event opens the local menu and skips
   the prior TUI cleanup; a pointer-up alone does not end the local drag.

These experiments establish code behavior, not Safari's exact triggering event.
The original focused suites passed before repair and did not cover the combined
native-selection and selection-invalidation cases. The new regressions exercise
those cases, including compatibility events without pointer events and release
events whose bubbling path is interrupted.

## Confirming the Safari diagnosis

While the tint is present, this read-only expression in Safari's Web Inspector
reports whether a native selection range intersects a terminal canvas:

```javascript
(() => {
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i))
    : [];
  return {
    type: selection?.type,
    ranges: ranges.length,
    selectedTerminalCanvases: Array.from(
      document.querySelectorAll(".terminal-container canvas")
    ).filter(canvas => ranges.some(range => range.intersectsNode(canvas))).length,
  };
})()
```

If a range intersects the canvas, temporarily clearing the native selection
with `window.getSelection()?.removeAllRanges()` should remove a native tint.
If it does, that directly confirms the primary diagnosis. A canvas range may
have an empty `selection.toString()` because the terminal text is painted
pixels, so an empty string alone does not rule this out.

## Repair implemented

1. The mouse bridge recognizes macOS Control-primary-click in both pointer and
   compatibility mouse events before Ghostty can start a drag. Its click capture
   prevents that contextual gesture from activating either link provider;
   Command-click and other platforms' Control-click retain their normal paths.
2. Standard and WebKit-prefixed CSS suppress canvas/container native selection
   while retaining textarea selection for clipboard fallback. A terminal-scoped
   listener cancels canvas `selectstart` and removes only native ranges owned by
   that terminal that intersect its canvas. Editor, clipboard-field and
   cross-pane ranges are preserved. Focus and context-menu handling also clear
   stale native canvas ranges.
3. `web/terminal-selection.mjs` adapts the pinned private selection manager so
   its invalidation requests a scheduled frame. Dragging, clearing and
   programmatic selection no longer depend on output or cursor blinking.
4. Capture listeners recover releases, cancellation, context menus, focus loss,
   hidden documents and zero-button movement. Interrupted drags retain selected
   text but stop autoscroll; zero-length drags are reset. Normal releases retain
   upstream selection copying exactly once. Ordinary clicks no longer copy a
   single character from a zero-length range. Disposal removes recovery
   listeners and restores upstream methods.

The production bundle was rebuilt and its import version advanced. All 350
frontend tests, JavaScript syntax checks and whitespace checks pass. The normal
Go suite encountered an unrelated existing test that binds port 7331, occupied
by a running Tessera instance. The full suite then passed with a temporary Go
overlay changing only that test's HTTP address to an ephemeral port; the
repository's server test and the running instance were left unchanged.

Live Safari verification of the original gesture remains outstanding on this
Windows host. Manual checks should include Control-click and Command-click on
detected and OSC 8 links, normal/full-screen layouts, ordinary/Shift-drag,
secondary-click copying and interrupted edge autoscroll. No keyboard-focus or
editable-container refactor was needed for this repair.
