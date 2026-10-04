# Task 132: Tessera Sessions command

Status: complete

Name the session manager Tessera Sessions in the command palette and radial
menu. Typing se in the palette highlights Settings first, including when an
active pane makes Set Window Title available. Keep Settings on S and expose
Tessera Sessions through TS in both menus.

Validate search ranking and selection against the built command list, session
manager dispatch, and wheel keyboard and pointer access.

Renamed the shared command and added TS to the palette codes. The wheel shows
a Tessera Sessions group on T with its S command. Settings precedes other
equally ranked prefix matches so se selects it before Set Window Title; the
existing search scoring and S shortcut remain in use.

Validation: all 17 command-wheel/palette tests passed, including search with
and without an active pane, session searches, and keyboard/pointer dispatch.
`go test ./web`, JavaScript syntax, and whitespace checks passed.
