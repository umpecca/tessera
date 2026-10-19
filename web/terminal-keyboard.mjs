const navigationKeys = {
  Home: { final: "H", sequence: "\x1B[H" },
  End: { final: "F", sequence: "\x1B[F" },
  Insert: { number: 2, sequence: "\x1B[2~" },
  Delete: { number: 3, sequence: "\x1B[3~" },
  PageUp: { number: 5, sequence: "\x1B[5~" },
  PageDown: { number: 6, sequence: "\x1B[6~" },
  Clear: { final: "E", sequence: "\x1B[E" },
};

const normalCursorSequences = {
  ArrowUp: "\x1B[A",
  ArrowDown: "\x1B[B",
  ArrowRight: "\x1B[C",
  ArrowLeft: "\x1B[D",
};

const cursorFinals = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
};

const applicationCursorSequences = {
  ArrowUp: "\x1BOA",
  ArrowDown: "\x1BOB",
  ArrowRight: "\x1BOC",
  ArrowLeft: "\x1BOD",
};

const applicationKeypadSequences = {
  Numpad0: "\x1BOp",
  Numpad1: "\x1BOq",
  Numpad2: "\x1BOr",
  Numpad3: "\x1BOs",
  Numpad4: "\x1BOt",
  Numpad5: "\x1BOu",
  Numpad6: "\x1BOv",
  Numpad7: "\x1BOw",
  Numpad8: "\x1BOx",
  Numpad9: "\x1BOy",
  NumpadDecimal: "\x1BOn",
  NumpadEnter: "\x1BOM",
  NumpadAdd: "\x1BOk",
  NumpadSubtract: "\x1BOm",
  NumpadMultiply: "\x1BOj",
  NumpadDivide: "\x1BOo",
  NumpadEqual: "\x1BOX",
  NumpadComma: "\x1BOl",
  NumpadSeparator: "\x1BOl",
};

function xtermModifier(event) {
  return 1
    + (event.shiftKey ? 1 : 0)
    + (event.altKey ? 2 : 0)
    + (event.ctrlKey ? 4 : 0)
    + (event.metaKey ? 8 : 0);
}

function hasModifier(event) {
  return Boolean(event.shiftKey || event.altKey || event.ctrlKey || event.metaKey);
}

// Where the pasted text has to come from for a given keystroke:
//
//   "native"    - the browser fires a paste event for this combination and
//                 ghostty-web reads it from event.clipboardData, which needs no
//                 clipboard permission and works on insecure origins. Tessera
//                 must not intercept these; consuming the key suppresses the
//                 paste event and nothing arrives.
//   "clipboard" - no paste event is coming, because the combination is not this
//                 platform's paste accelerator (Ctrl+Shift+V, Shift+Insert), so
//                 Tessera reads the clipboard itself.
//
// Copy is not symmetric: a canvas terminal has no DOM selection for the browser
// to copy, so Tessera always handles the copy shortcuts itself.
export function terminalPasteSource(event, options = {}) {
  if (!event || event.altKey) {
    return null;
  }
  if (event.key === "Insert") {
    return event.shiftKey && !event.ctrlKey && !event.metaKey ? "clipboard" : null;
  }

  const isV = event.key?.toLowerCase() === "v" || event.code === "KeyV";
  if (!isV || (event.ctrlKey && event.metaKey)) {
    return null;
  }
  const acceleratorHeld = options.appleKeyboard ? event.metaKey : event.ctrlKey;
  if (acceleratorHeld && !event.shiftKey) {
    return "native";
  }
  if (event.ctrlKey && event.shiftKey) {
    return "clipboard";
  }
  // A Command key on a non-Apple platform is nobody's paste accelerator.
  if (event.metaKey && !event.shiftKey && !options.appleKeyboard) {
    return "clipboard";
  }
  return null;
}

// Chrome owns Command+V on macOS, but a terminal input listener must not see
// the keydown itself: some raw-mode TUIs otherwise receive a literal `v` even
// though the browser shortcut is meant to paste. The caller stops propagation
// without preventing the default action, so Chrome can still emit its trusted
// paste event with system-clipboard data.
export function shouldIsolateMacTerminalPasteKeydown(event, options = {}) {
  return Boolean(
    options.appleKeyboard
    && event?.metaKey
    && terminalPasteSource(event, options) === "native"
  );
}

// Control codes for keystrokes ghostty-web drops instead of encoding.
//
// Its key handler returns early for Ctrl+V so the browser can deliver a paste
// event, which is right where Ctrl is the paste accelerator. On an Apple
// keyboard it is not — Command is — so the early return leaves Ctrl+V dead:
// nothing pastes, and the application never receives ^V either. Terminal.app
// sends it, and a TUI editor that binds paste to ^V needs it, so Tessera
// encodes it here. Every other Ctrl+letter already reaches the encoder.
export function terminalControlSequence(event, options = {}) {
  if (!event || !options.appleKeyboard) {
    return null;
  }
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return null;
  }
  const isV = event.key?.toLowerCase() === "v" || event.code === "KeyV";
  return isV ? "\x16" : null;
}

// Command is a menu accelerator on macOS, never terminal input: Terminal.app
// sends nothing to the PTY for Cmd+S. ghostty-web's key encoder drops the
// Super modifier and falls back to the key's own character, so Cmd+S types a
// bare "s" into whatever is running — Cmd+S in a TUI editor writes into the
// document instead of saving it. Consume those keystrokes instead.
//
// Only single-character keys reach that fallback, and the combinations Tessera
// binds itself (Cmd+C, Cmd+V) are resolved before this is consulted.
export function terminalShouldSwallowCommandKey(event) {
  if (!event || !event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  return event.key?.length === 1;
}

// The iPad Magic Keyboard has no Home or End key. On an Apple keyboard
// Command+Left and Command+Right stand in for them, as they go to the start
// and end of a line in macOS text fields. Command never reaches the
// application, so this takes no binding away from it. They send exactly what
// the Home and End keys send here (Globe+Left/Right on the iPad), so either
// works wherever the other does. That is not ^A and ^E, which mean other
// things in vim and tmux.
export function terminalCommandArrowSequence(event, options = {}) {
  if (!event || !options.appleKeyboard) {
    return null;
  }
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return null;
  }
  return event.key === "ArrowLeft" ? navigationKeys.Home.sequence
    : event.key === "ArrowRight" ? navigationKeys.End.sequence
      : null;
}

// Jump to the previous or next shell prompt (OSC 133): Command+Up and
// Command+Down on an Apple keyboard, as in Terminal.app and Ghostty, and
// Ctrl+Shift+Page Up/Page Down elsewhere (Ctrl+Shift+arrows move windows).
// Returns -1, 1, or 0 for any other key.
export function terminalPromptJumpDirection(event, options = {}) {
  if (!event || event.altKey) {
    return 0;
  }
  if (options.appleKeyboard && event.metaKey && !event.ctrlKey && !event.shiftKey) {
    return event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
  }
  if (event.ctrlKey && event.shiftKey && !event.metaKey) {
    return event.key === "PageUp" ? -1 : event.key === "PageDown" ? 1 : 0;
  }
  return 0;
}

export function isTerminalCopyShortcut(event) {
  if (!event || event.altKey) {
    return false;
  }
  const key = event.key?.toLowerCase();
  return Boolean(
    (key === "c" && event.metaKey && !event.ctrlKey && !event.shiftKey)
    || (key === "c" && event.ctrlKey && event.shiftKey && !event.metaKey)
  );
}

// ghostty-web maps KeyboardEvent.code, which identifies the physical key. Use
// the browser's logical key where the two differ:
//
//   - a physical numpad key, which is Home, End or an arrow with Num Lock off;
//   - on an Apple keyboard, an arrow that reports Home, End, PageUp or
//     PageDown. That is Globe+arrow on an iPad keyboard, which WebKit also
//     marks with Command, so ghostty-web sent Globe+Left as Command+Left,
//     `ESC [ 1 ; 9 D`, and zsh printed the unbound tail as `9D`.
//
// On an Apple keyboard Command is left out of the modifier. It never reaches
// the application, and the Home key itself sends the plain `ESC [ H`.
export function terminalNavigationSequence(event, modes = {}) {
  if (!event) {
    return null;
  }
  const numpad = event.code?.startsWith("Numpad");
  const relabeledArrow = modes.appleKeyboard && event.code?.startsWith("Arrow");
  if (!numpad && !relabeledArrow) {
    return null;
  }
  const keys = modes.appleKeyboard ? { ...event, metaKey: false } : event;

  if (numpad && modes.applicationKeypad) {
    return hasModifier(keys) ? null : applicationKeypadSequences[event.code] || null;
  }

  const navigation = navigationKeys[event.key];
  // An arrow reporting itself is the ordinary case, left to ghostty-web.
  const normalCursorSequence = numpad ? normalCursorSequences[event.key] : null;
  if (!navigation && !normalCursorSequence) {
    return null;
  }

  if (!hasModifier(keys)) {
    if (normalCursorSequence) {
      return modes.applicationCursorKeys ? applicationCursorSequences[event.key] : normalCursorSequence;
    }
    return navigation.sequence;
  }

  const modifier = xtermModifier(keys);
  if (normalCursorSequence) {
    return `\x1B[1;${modifier}${cursorFinals[event.key]}`;
  }
  if (navigation.number) {
    return `\x1B[${navigation.number};${modifier}~`;
  }
  return `\x1B[1;${modifier}${navigation.final}`;
}
