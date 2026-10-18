# Task 194: Key readout in Diagnostics

Status: complete (iPad readings pending)

## Request

The iPad Magic Keyboard has no Home, End or forward Delete. Before mapping
combinations to them (Cmd+Left/Right or Ctrl+Left/Right to Home/End,
Fn+Backspace or Ctrl+Backspace to Delete), find out what Safari on iPadOS
actually delivers for each combination. Start with a key readout.

## Changes

- `web/key-readout.mjs`: `describeKeyEvent` formats a keydown (modifiers
  with Apple names, `key`, `code`, `keyCode`, repeat/composing) or a
  beforeinput (`inputType`, `data`). `KeyReadout` keeps the last 12 lines
  at module level, so the log survives Settings re-rendering and reopening.
  `keyReadoutShouldPreventKeydown` cancels Command/Control character
  shortcuts (Cmd+R, Cmd+W) and lets everything else through, including Tab
  and Escape.
- `web/app.js`: Settings → Diagnostics gains a key test field below the
  compatibility checks, with **Copy key log** (headed with browser and
  platform, not the full user agent) and **Clear**. The field keeps the
  text "Press keys here" with the cursor mid-word; every beforeinput is
  logged and cancelled, and keyup restores the text and cursor. Deletes in
  both directions therefore have text to act on, so the browser still
  reports which way a key deletes (`deleteContentBackward` or
  `deleteContentForward`), which decides Fn+Backspace.
- `web/styles.css`: field and log styles; the log numbers count down so the
  newest line is on top.
- `web/embed.go`: embeds the module.

## Validation

- `web/key-readout.test.mjs`: modifier names, keydown and beforeinput
  lines, the 12-line limit and copy order, which keydowns are cancelled.
  Settings fixture stubs the new row. Full JavaScript suite: 643 pass; Go
  suite passes.
- Real host, headless Chrome on the Mac, keys sent over the DevTools
  protocol: a, Cmd+Left, Ctrl+Right, Backspace, Ctrl+Backspace, Delete and
  Cmd+R each logged one keydown; a, Backspace and Delete also logged their
  beforeinput; the field kept its text with the cursor at 6; Escape closed
  Settings and all lines were back on reopening; no page errors.
- Not yet run in Safari on the iPad, which is what this is for.

## Next

Record on the iPad: Cmd+Left/Right, Ctrl+Left/Right, Option+Left/Right,
Fn+Backspace, Ctrl+Backspace, Cmd+Backspace, Globe+Left/Right. Then map the
missing keys in `web/terminal-keyboard.mjs`, and extend prediction (task
191) to Home/End so the mapped keys do not end a predicted run.
