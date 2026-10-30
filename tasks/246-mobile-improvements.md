# Task 246: Mobile improvements

Status: in progress (2026-10-30). Two-finger scrolling built; the rest is
scoped only.

## Background

A phone switched to the desktop view had no way back once the Deskbar
button was hidden: the Phone View command lives in the command palette,
which wants Ctrl+K or the workspace menu, and the workspace menu opens only
on a right-click, which iOS Safari doesn't fire on a long-press. `/m` was the
only way out.

## Done

- **Phone View in the Window list.** The Deskbar panel (opened from the
  Deskbar button) has a Phone View entry beside Sessions and Settings.
- **Display settings per kind of device.** Phones keep their own theme
  (current and default), default font size, Deskbar button, OLED border,
  terminal font, row spacing, terminal colors and wheel speed
  (`phone_settings`, migration 057). Desktops and iPads share the account's
  settings. TERM and shell integration stay shared because they change the
  host's shells. A phone is a touch screen under 600 points on its shorter
  side (`isPhoneDevice` in `web/phone-view.mjs`), whatever view it shows.
  Phones start from the defaults, not a copy of the desktop's.
- **Two-finger scrolling in terminals.** See "Two-finger scrolling" below.

## To do

1. **An escape hatch that can't be hidden.** A phone in the desktop view
   always shows the Deskbar button, even when it is set to hidden. Phones
   keep their own settings, but hiding the button on the phone itself still
   strands it. About one line in `updateDeskbar`.
2. **Long-press for the workspace menu on touch screens.** The menu opens
   only on `contextmenu`, which iOS Safari doesn't fire on a long-press, so
   desktop view on a phone, or an iPad without a mouse, can't reach it.
   Add a long-press on the desktop background, and a Phone View entry in
   the menu.
3. **No false conflicts between phone and desktop saves.** Both sets share
   one settings revision, so a desktop change followed by a phone change
   gets "Settings changed in another browser" on the phone, though they
   touch different settings. Give each set its own revision, or have the
   server flag a conflict only when the same set changed.
4. **"Copy desktop settings" on phones.** A Settings button, shown only on
   a phone, that copies the desktop's theme and fonts as a starting point
   and leaves the Deskbar button showing.
5. **Keep the phone view's text/screen choice with the phone settings.**
   It lives in browser storage (`phoneReadingStorageKey`), so a second phone
   or a cleared browser starts over.

## Two-finger scrolling

Phone view's screen mode had no way to scroll a terminal: the container is
`touch-action: pan-x` (one finger pans a zoomed screen sideways), and a
one-finger drag is a press for programs that read the mouse. Two fingers
dragged up or down now scroll like the wheel:

- **Scrollback** (a shell, or Claude Code in its usual inline mode): the
  content follows the fingers line for line, using the same smooth scroll
  as the wheel.
- **A program that reads the mouse** (Claude Code's full-screen mode, vim
  with `mouse=a`, less with mouse support): one wheel report per line of
  finger travel.
- **A full-screen program that doesn't read the mouse:** one up or down
  arrow per line, as the wheel sends.

When the second finger lands, the first finger's press is released to the
program, and a selection it started is dropped. The gesture keeps the
remaining finger until it lifts, so lifting one finger early doesn't start
a selection.

Open questions, for a test on a real phone:

- Whether the speed suits programs that read the mouse. Claude Code
  scrolls several lines per wheel report, so one report per line of travel
  may feel fast.
- Whether it wants momentum (a flick that keeps scrolling).
- Whether iPad desktop view, where the terminal container has no
  `touch-action`, gets the pointer events or loses them to page panning.
