# Task 130: Experimental leader command wheel

Status: complete

Add a game-style radial command wheel alongside the searchable command palette.
Use Ctrl/Cmd+; to open it; keep Ctrl/Cmd+K for the palette. Reuse available
palette commands and their two-letter codes. Keep the first key visible while
revealing valid second keys. Support typing, clicking, Backspace, Escape,
outside dismissal, and keyboard focus containment/restoration. Offer palette
search for commands without codes and dynamic window/session entries.

Use translucent wedges, a gold selected group, a central context hub, and an
outer fan of next-key commands. Fit narrow displays and relay the opener from
browser panes. Validate command dispatch, unavailable/invalid keys, focus,
palette coexistence, browser-pane opening, and actual browser interaction.

Implemented as a native-button dialog using the palette's command objects and
available fixed codes. Stable inner wedges retain first-key groups; the outer
fan reveals second keys. Deliberate pointer movement previews a group; clicking
or typing pins it. A stationary pointer does not select a group when opened
from the keyboard. The hub shows the selected command and its key sequence.
Workspace-menu and palette entries provide pointer access. Search hands off
to the palette, and dismissal restores the active pane's focus. Invalid keys,
composition, and repeated strokes do not dispatch commands. The browser proxy
relays the opener; ordinary letters and destructive shortcuts stay local.

Validation:

- All 323 frontend tests passed, including nine wheel regressions for group
  availability, dispatch, invalid/repeated input, back navigation, opener,
  modal isolation, focus handoff, the iframe relay, sector geometry, and pinning.
- Initial integration passed `go test ./...` and `go vet ./...`. The final
  radial design passed `go test ./web`, JavaScript syntax, and whitespace checks.
- Actual Chromium checks passed for keyboard and pointer creation, parent
  switching, Tab containment, dismissal and focus restoration, preservation
  of worksheet contents, palette coexistence, outside dismissal, and opening
  from a proxied Browser pane. Hover, pinned selection, command previews, and
  touch creation also passed. No uncaught browser errors occurred.
- First- and second-key layouts fit at 1280, 375, and 320px without overlapping
  labels or horizontal overflow. All available groups' labels fit within their
  clickable sectors. Visual screenshots were inspected.
