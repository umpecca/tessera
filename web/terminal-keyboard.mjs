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
// the browser's logical key only when a physical numpad key needs translation.
export function terminalNavigationSequence(event, modes = {}) {
  if (!event || !event.code?.startsWith("Numpad")) {
    return null;
  }

  if (modes.applicationKeypad) {
    return hasModifier(event) ? null : applicationKeypadSequences[event.code] || null;
  }

  const navigation = navigationKeys[event.key];
  const normalCursorSequence = normalCursorSequences[event.key];
  if (!navigation && !normalCursorSequence) {
    return null;
  }

  if (!hasModifier(event)) {
    if (normalCursorSequence) {
      return modes.applicationCursorKeys ? applicationCursorSequences[event.key] : normalCursorSequence;
    }
    return navigation.sequence;
  }

  const modifier = xtermModifier(event);
  if (normalCursorSequence) {
    return `\x1B[1;${modifier}${cursorFinals[event.key]}`;
  }
  if (navigation.number) {
    return `\x1B[${navigation.number};${modifier}~`;
  }
  return `\x1B[1;${modifier}${navigation.final}`;
}
