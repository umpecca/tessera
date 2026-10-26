# Task 233: View a terminal without resizing it

Status: complete (iPhone check pending)

## Request

Let a phone read and use a terminal without changing the shell's size, so
checking in from a phone doesn't break the layout of programs on the
desktop or iPad. Builds on tasks 231 and 232.

## Findings

- A shell has one size however many browsers show it. `join` gave the size
  to the first browser to attach when nobody else was, and the fit
  scheduler sent a browser's grid whenever its fit changed, as well as on
  every key, click and paste (`claimTerminalSize`). Opening a terminal on
  the phone therefore resized it at once, before anyone typed.
- The browser's terminal always runs at the host's grid (`applyGeometry`);
  fitting only records the grid it would like (`desiredCols`). So a phone
  that stops sending its grid already shows the shell at the desk's size,
  with the canvas as wide as the host's columns at the phone's font.
- Scaling that canvas with CSS would have broken selection, links and
  mouse reports, which measure the page in unscaled cells. A smaller font
  keeps the grid and every coordinate consistent; `term.options.fontSize`
  changes live without touching the pane's saved size.
- The renderer rounds cells to whole pixels, so below about 4 points a
  smaller font no longer makes cells narrower: 153 columns at the 4-point
  floor are 459 px on a 390 px phone. At that size the screen is unreadable
  anyway (see the screenshots of the browser check), so text is the default.
- The buffer's `isWrapped` is false for scrollback rows, but the core's
  semantic marks (`tessera_semantic_rows`) carry the soft-wrap bit for every
  row, so text view can join wrapped rows without changing the bundled
  terminal.

## Changes

- `internal/terminal/size.go`: `ClaimSize` / `ReleaseSize`. A claim keeps
  the size it took over across further claims by the same owner; release
  puts it back only if no other resize happened since (`sizeGeneration`,
  counted in `resizeLocked`).
- `internal/terminal/manager.go`: `Cursor.Watch`; a watching attach never
  sizes the shell.
- `internal/httpapi/terminal.go`: `watch=1` on the socket URL; a resize with
  `temporary: true` claims for this socket; `release-size` releases; the
  socket closing releases.
- `web/terminal-fit-scheduler.mjs`: `watchesSize` (send nothing) and
  `sizeIsTemporary` (mark resizes temporary) options.
- `web/app.js`: in the phone view every socket attaches watching and no
  terminal sends its grid, unless that terminal is fitted to the phone
  (`state.phoneFit`), whose resizes are temporary. The open terminal's font
  fits the shell's columns to the width (`phoneFontSize`, times the zoom),
  measured again after the font changes; going back restores the pane's
  font, the zoom and releases a fit. A page put away releases the size it
  took; coming back reconnects and takes it again. `phoneReadingText` reads
  the last 2000 rows with their wrap marks.
- `web/phone-view.mjs`: **Aa** menu (the shell's size and whose it is,
  Screen / Text, Larger / Smaller, Fit to this phone) and the text view
  (refreshed each second while open, following output unless scrolled up;
  the screen for a full-screen program). Text is the default; the choice is
  kept per browser. `readingLines`, `phoneFontSize`.
- `web/styles.css`: the open terminal scrolls sideways when enlarged; text
  view over the terminal area.
- `README.md`, `CHANGELOG.md`, `ARCHITECTURE.md`.

## Fix: the screen swinging between two sizes

Reported from use: a terminal opened on the phone could jump between a
large and a small font for as long as it was open. Reproduced with a
37-column shell (made by the phone in the desktop view): the canvas
alternated 407 px and 370 px every frame while the shell's size never
changed. The font was computed from the cell width measured at the
current font, then measured again and recomputed; cells round to whole
pixels, so size A suggested B and B suggested A. Wide shells hid it, since
the 4-point floor stopped them.

- `phoneFontShrink` (`web/phone-view.mjs`): after the first estimate, only
  ever step down, and only while the columns overflow; it settles.
- `applyPhoneTerminalFont` (`web/app.js`) finds the fitting font once per
  column count and width (`phoneFitFont`); Larger and Smaller multiply it,
  where they had multiplied an estimate below the floor and barely grew a
  wide shell (467 px for two Larger, now 620 px again).
- `web/phone-view.test.mjs`: with whole-pixel cells, 20 to 153 columns all
  settle, only ever smaller, and fit or reach the floor.
- Browser: the 37-column case now shows two states (opening, settled);
  resizing the shell to 20, 37, 45, 60, 80, 100 and 120 columns under the
  open phone settled on one canvas width each time; the 231–234 browser
  checks pass.

## Departures from the plan

- Larger and Smaller buttons instead of pinch to zoom: panes set
  `touch-action: none`, and buttons need no gesture handling.
- Text view first, not the scaled screen (the plan's open question): a
  desk's terminal is too wide to read as a screen on a phone.
- The header doesn't name which browser has the size; the **Aa** menu says
  the shell's size and whether it is fitted to this phone.

## Validation

- `internal/terminal/size_test.go` (`-race`): claim, re-claim with the
  keyboard up, release by another owner ignored, release restoring, a
  second release; a desk resize in between is kept, and a later claim gives
  that back; a watching attach leaves the size, an ordinary one takes it.
- `internal/httpapi/terminal_size_test.go` (`-race`): real PTY and sockets:
  a watching socket alone doesn't size the shell (and does without
  `watch=1`, checked); a temporary resize applies; `release-size` and
  closing the socket give the size back.
- `web/terminal-fit-scheduler.test.mjs`: a watching terminal sends nothing
  from a fit or a claim; a temporary one marks its resize.
  `web/terminal-backlog.test.mjs`: phone sockets attach with `watch=1`.
  `web/phone-view.test.mjs`: wrapped rows joined with their spaces, trailing
  blanks and blank rows dropped; font sizes; the view menu's items and
  states, text view shown and remembered, a full-screen program shown as
  the screen, no zoom while fitted, text as the default. Harnesses in
  `terminal-colors`, `terminal-backlog` and `terminal-hidden-output` stub
  the new function.
- Full JavaScript suite: 792 pass. `go test ./...`, `go vet ./...` and
  `git diff --check` pass.
- Real host, built binary, this account's zsh, headless Chrome (desk
  1400×900 with a maximized 153×46 terminal, phone 390×844 with touch):
  loading the phone, opening the terminal, sending `stty size`, ↑, `^C`
  and tapping the screen left it 153×46, and `stty size` from the phone
  said `46 153`; the screen fitted at the smallest font and Larger made it
  scroll sideways; text view showed a 230-character line whole; Fit to this
  phone made it 42×36 (`stty size` agreed); Back gave 153×46 back; fitted
  again, a hidden page gave it back and showing it again fitted it again;
  closing the phone's page gave it back. The 231 and 232 browser checks
  still pass.
- Not tried on an iPhone (real keyboard, Safari's backgrounding, sideways
  scrolling by touch).
