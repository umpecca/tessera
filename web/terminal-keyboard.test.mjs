import assert from "node:assert/strict";
import test from "node:test";

import {
  isTerminalCopyShortcut,
  terminalPromptJumpDirection,
  shouldIsolateMacTerminalPasteKeydown,
  terminalCommandArrowSequence,
  terminalControlSequence,
  terminalNavigationSequence,
  terminalPasteSource,
  terminalShiftedKeySequence,
  terminalShouldSwallowCommandKey,
} from "./terminal-keyboard.mjs";

test("encodes unmodified logical navigation from physical numpad keys", () => {
  const cases = [
    ["Home", "Numpad7", "\x1B[H"],
    ["End", "Numpad1", "\x1B[F"],
    ["Insert", "Numpad0", "\x1B[2~"],
    ["Delete", "NumpadDecimal", "\x1B[3~"],
    ["PageUp", "Numpad9", "\x1B[5~"],
    ["PageDown", "Numpad3", "\x1B[6~"],
    ["Clear", "Numpad5", "\x1B[E"],
    ["ArrowUp", "Numpad8", "\x1B[A"],
    ["ArrowDown", "Numpad2", "\x1B[B"],
    ["ArrowRight", "Numpad6", "\x1B[C"],
    ["ArrowLeft", "Numpad4", "\x1B[D"],
  ];
  for (const [key, code, sequence] of cases) {
    assert.equal(terminalNavigationSequence({ key, code }), sequence);
  }
  assert.equal(
    terminalNavigationSequence({ key: "ArrowUp", code: "Numpad8" }, { applicationCursorKeys: true }),
    "\x1BOA",
  );
});

test("encodes modified numpad navigation with xterm modifier parameters", () => {
  assert.equal(terminalNavigationSequence({ key: "ArrowUp", code: "Numpad8", shiftKey: true }), "\x1B[1;2A");
  assert.equal(terminalNavigationSequence({ key: "ArrowDown", code: "Numpad2", altKey: true }), "\x1B[1;3B");
  assert.equal(terminalNavigationSequence({ key: "ArrowRight", code: "Numpad6", ctrlKey: true }), "\x1B[1;5C");
  assert.equal(terminalNavigationSequence({ key: "ArrowLeft", code: "Numpad4", metaKey: true }), "\x1B[1;9D");
  assert.equal(terminalNavigationSequence({ key: "Home", code: "Numpad7", ctrlKey: true }), "\x1B[1;5H");
  assert.equal(terminalNavigationSequence({ key: "End", code: "Numpad1", altKey: true }), "\x1B[1;3F");
  assert.equal(terminalNavigationSequence({ key: "Insert", code: "Numpad0", ctrlKey: true }), "\x1B[2;5~");
  assert.equal(terminalNavigationSequence({ key: "Delete", code: "NumpadDecimal", shiftKey: true }), "\x1B[3;2~");
  assert.equal(terminalNavigationSequence({ key: "PageUp", code: "Numpad9", altKey: true }), "\x1B[5;3~");
  assert.equal(terminalNavigationSequence({ key: "PageDown", code: "Numpad3", metaKey: true }), "\x1B[6;9~");
  assert.equal(terminalNavigationSequence({ key: "Clear", code: "Numpad5", ctrlKey: true }), "\x1B[1;5E");
});

test("encodes every unmodified VT application-keypad key", () => {
  const cases = {
    Numpad0: "\x1BOp", Numpad1: "\x1BOq", Numpad2: "\x1BOr", Numpad3: "\x1BOs",
    Numpad4: "\x1BOt", Numpad5: "\x1BOu", Numpad6: "\x1BOv", Numpad7: "\x1BOw",
    Numpad8: "\x1BOx", Numpad9: "\x1BOy", NumpadDecimal: "\x1BOn", NumpadEnter: "\x1BOM",
    NumpadAdd: "\x1BOk", NumpadSubtract: "\x1BOm", NumpadMultiply: "\x1BOj",
    NumpadDivide: "\x1BOo", NumpadEqual: "\x1BOX", NumpadComma: "\x1BOl",
    NumpadSeparator: "\x1BOl",
  };
  for (const [code, sequence] of Object.entries(cases)) {
    assert.equal(terminalNavigationSequence({ key: "unused", code }, { applicationKeypad: true }), sequence);
  }
});

test("leaves ordinary numpad input, dedicated keys, and modified application-keypad input alone", () => {
  assert.equal(terminalNavigationSequence({ key: "7", code: "Numpad7" }), null);
  assert.equal(terminalNavigationSequence({ key: "0", code: "Numpad0" }), null);
  assert.equal(terminalNavigationSequence({ key: ".", code: "NumpadDecimal" }), null);
  assert.equal(terminalNavigationSequence({ key: "ArrowUp", code: "ArrowUp" }), null);
  assert.equal(terminalNavigationSequence({ key: "Home", code: "Home" }), null);
  assert.equal(terminalNavigationSequence(
    { key: "ArrowUp", code: "Numpad8", ctrlKey: true },
    { applicationKeypad: true },
  ), null);
  assert.equal(terminalNavigationSequence(null), null);
});

const apple = { appleKeyboard: true };

test("leaves the platform paste accelerator to the browser's paste event", () => {
  // Consuming these would cancel the paste event ghostty-web reads.
  assert.equal(terminalPasteSource({ key: "v", metaKey: true }, apple), "native");
  assert.equal(terminalPasteSource({ key: "V", metaKey: true }, apple), "native");
  assert.equal(terminalPasteSource({ key: "v", code: "KeyV", metaKey: true }, apple), "native");
  assert.equal(terminalPasteSource({ key: "v", ctrlKey: true }), "native");
  assert.equal(terminalPasteSource({ key: "V", ctrlKey: true }), "native");
});

test("reads the clipboard for combinations the browser never reports", () => {
  assert.equal(terminalPasteSource({ key: "Insert", shiftKey: true }, apple), "clipboard");
  assert.equal(terminalPasteSource({ key: "Insert", shiftKey: true }), "clipboard");
  assert.equal(terminalPasteSource({ key: "v", ctrlKey: true, shiftKey: true }, apple), "clipboard");
  assert.equal(terminalPasteSource({ key: "v", ctrlKey: true, shiftKey: true }), "clipboard");
  // A Command key away from macOS is nobody's accelerator.
  assert.equal(terminalPasteSource({ key: "v", metaKey: true }), "clipboard");
});

test("ignores keystrokes that are not paste requests", () => {
  assert.equal(terminalPasteSource({ key: "Insert", shiftKey: true, ctrlKey: true }, apple), null);
  assert.equal(terminalPasteSource({ key: "Insert" }, apple), null);
  assert.equal(terminalPasteSource({ key: "Delete", shiftKey: true }, apple), null);
  assert.equal(terminalPasteSource({ key: "v", metaKey: true, altKey: true }, apple), null);
  assert.equal(terminalPasteSource({ key: "v", ctrlKey: true, metaKey: true }, apple), null);
  assert.equal(terminalPasteSource({ key: "c", metaKey: true }, apple), null);
  assert.equal(terminalPasteSource(null, apple), null);
  // Plain Ctrl+V on macOS is not a paste shortcut there.
  assert.equal(terminalPasteSource({ key: "v", ctrlKey: true }, apple), null);
});

test("isolates only macOS Command+V before terminal input handlers", () => {
  assert.equal(shouldIsolateMacTerminalPasteKeydown({ key: "v", metaKey: true }, apple), true);
  assert.equal(shouldIsolateMacTerminalPasteKeydown({ key: "V", metaKey: true }, apple), true);
  assert.equal(
    shouldIsolateMacTerminalPasteKeydown({ key: "v", code: "KeyV", metaKey: true }, apple),
    true,
  );

  // Windows/Linux Ctrl+V stays on its existing native-paste path.
  assert.equal(shouldIsolateMacTerminalPasteKeydown({ key: "v", ctrlKey: true }), false);
  // Tessera's explicit clipboard paste and macOS ^V remain unchanged.
  assert.equal(
    shouldIsolateMacTerminalPasteKeydown({ key: "v", ctrlKey: true, shiftKey: true }, apple),
    false,
  );
  assert.equal(shouldIsolateMacTerminalPasteKeydown({ key: "v", ctrlKey: true }, apple), false);
  assert.equal(shouldIsolateMacTerminalPasteKeydown({ key: "v", metaKey: true, shiftKey: true }, apple), false);
  assert.equal(shouldIsolateMacTerminalPasteKeydown({ key: "c", metaKey: true }, apple), false);
  assert.equal(shouldIsolateMacTerminalPasteKeydown(null, apple), false);
});

test("encodes Ctrl+V as ^V on an Apple keyboard, where it is not the paste accelerator", () => {
  assert.equal(terminalControlSequence({ key: "v", ctrlKey: true }, apple), "\x16");
  assert.equal(terminalControlSequence({ key: "V", ctrlKey: true }, apple), "\x16");
  assert.equal(terminalControlSequence({ key: "v", code: "KeyV", ctrlKey: true }, apple), "\x16");
});

test("leaves Ctrl+V alone where it is the paste accelerator", () => {
  // Off macOS this is the browser's paste event, which must not be consumed.
  assert.equal(terminalControlSequence({ key: "v", ctrlKey: true }), null);
  assert.equal(terminalControlSequence({ key: "v", code: "KeyV", ctrlKey: true }, {}), null);
});

test("encodes no control sequence for other keystrokes", () => {
  // Ctrl+Shift+V is Tessera's own clipboard paste, and Ctrl+C already reaches
  // ghostty-web's encoder as ^C.
  assert.equal(terminalControlSequence({ key: "v", ctrlKey: true, shiftKey: true }, apple), null);
  assert.equal(terminalControlSequence({ key: "v", ctrlKey: true, metaKey: true }, apple), null);
  assert.equal(terminalControlSequence({ key: "v", ctrlKey: true, altKey: true }, apple), null);
  assert.equal(terminalControlSequence({ key: "v", metaKey: true }, apple), null);
  assert.equal(terminalControlSequence({ key: "c", ctrlKey: true }, apple), null);
  assert.equal(terminalControlSequence({ key: "v" }, apple), null);
  assert.equal(terminalControlSequence(null, apple), null);
});

test("swallows bare Command keystrokes that would otherwise type their character", () => {
  for (const key of ["s", "z", "a", "f", "x", "S"]) {
    assert.equal(terminalShouldSwallowCommandKey({ key, metaKey: true }), true);
  }
});

test("leaves keystrokes the Command key does not turn into stray input", () => {
  // Multi-character keys never reach the encoder's character fallback.
  assert.equal(terminalShouldSwallowCommandKey({ key: "Enter", metaKey: true }), false);
  assert.equal(terminalShouldSwallowCommandKey({ key: "Backspace", metaKey: true }), false);
  assert.equal(terminalShouldSwallowCommandKey({ key: "ArrowLeft", metaKey: true }), false);
  // Control and Option combinations are encoded normally.
  assert.equal(terminalShouldSwallowCommandKey({ key: "s", ctrlKey: true }), false);
  assert.equal(terminalShouldSwallowCommandKey({ key: "s", metaKey: true, ctrlKey: true }), false);
  assert.equal(terminalShouldSwallowCommandKey({ key: "s", metaKey: true, altKey: true }), false);
  assert.equal(terminalShouldSwallowCommandKey({ key: "s" }), false);
  assert.equal(terminalShouldSwallowCommandKey(null), false);
});

test("recognizes terminal copy shortcuts without consuming Ctrl+C", () => {
  assert.equal(isTerminalCopyShortcut({ key: "c", metaKey: true }), true);
  assert.equal(isTerminalCopyShortcut({ key: "C", metaKey: true }), true);
  assert.equal(isTerminalCopyShortcut({ key: "c", ctrlKey: true, shiftKey: true }), true);
  assert.equal(isTerminalCopyShortcut({ key: "c", ctrlKey: true }), false);
  assert.equal(isTerminalCopyShortcut({ key: "c", metaKey: true, shiftKey: true }), false);
  assert.equal(isTerminalCopyShortcut({ key: "c", metaKey: true, altKey: true }), false);
  assert.equal(isTerminalCopyShortcut({ key: "v", metaKey: true }), false);
  assert.equal(isTerminalCopyShortcut(null), false);
});

test("sends Home and End for Command+Left and Command+Right on an Apple keyboard", () => {
  const apple = { appleKeyboard: true };
  assert.equal(terminalCommandArrowSequence({ key: "ArrowLeft", metaKey: true }, apple), "\x1B[H");
  assert.equal(terminalCommandArrowSequence({ key: "ArrowRight", metaKey: true }, apple), "\x1B[F");
});

test("leaves other arrows, modifiers and keyboards to the encoder", () => {
  const apple = { appleKeyboard: true };
  assert.equal(terminalCommandArrowSequence({ key: "ArrowLeft", metaKey: true }, {}), null);
  assert.equal(terminalCommandArrowSequence({ key: "ArrowLeft" }, apple), null);
  assert.equal(terminalCommandArrowSequence({ key: "ArrowLeft", ctrlKey: true }, apple), null);
  assert.equal(terminalCommandArrowSequence({ key: "ArrowLeft", altKey: true }, apple), null);
  assert.equal(terminalCommandArrowSequence({ key: "ArrowUp", metaKey: true }, apple), null);
  assert.equal(terminalCommandArrowSequence({ key: "Backspace", metaKey: true }, apple), null);
  for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }]) {
    assert.equal(terminalCommandArrowSequence({ key: "ArrowRight", metaKey: true, ...extra }, apple), null);
  }
  assert.equal(terminalCommandArrowSequence(null, apple), null);
});

test("encodes Globe+arrow by the logical key it reports, without Command", () => {
  const apple = { appleKeyboard: true };
  const cases = [
    ["Home", "ArrowLeft", "\x1B[H"],
    ["End", "ArrowRight", "\x1B[F"],
    ["PageUp", "ArrowUp", "\x1B[5~"],
    ["PageDown", "ArrowDown", "\x1B[6~"],
  ];
  for (const [key, code, sequence] of cases) {
    assert.equal(terminalNavigationSequence({ key, code, metaKey: true }, apple), sequence);
    assert.equal(terminalNavigationSequence({ key, code }, apple), sequence);
  }
  assert.equal(
    terminalNavigationSequence({ key: "Home", code: "ArrowLeft", metaKey: true, shiftKey: true }, apple),
    "\x1B[1;2H",
  );
  assert.equal(
    terminalNavigationSequence({ key: "PageDown", code: "ArrowDown", metaKey: true, ctrlKey: true }, apple),
    "\x1B[6;5~",
  );
});

test("leaves real arrows and real Home keys to the encoder, and Globe+arrow off Apple keyboards", () => {
  const apple = { appleKeyboard: true };
  assert.equal(terminalNavigationSequence({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }, apple), null);
  assert.equal(terminalNavigationSequence({ key: "Home", code: "Home" }, apple), null);
  assert.equal(terminalNavigationSequence({ key: "Home", code: "ArrowLeft", metaKey: true }, {}), null);
  assert.equal(terminalNavigationSequence(null, apple), null);
});

test("leaves Command out of numpad navigation on an Apple keyboard", () => {
  const apple = { appleKeyboard: true };
  assert.equal(terminalNavigationSequence({ key: "Home", code: "Numpad7", metaKey: true }, apple), "\x1B[H");
  assert.equal(terminalNavigationSequence({ key: "ArrowLeft", code: "Numpad4", metaKey: true }, apple), "\x1B[D");
  assert.equal(
    terminalNavigationSequence({ key: "PageUp", code: "Numpad9", metaKey: true, altKey: true }, apple),
    "\x1B[5;3~",
  );
  assert.equal(
    terminalNavigationSequence({ key: "Numpad7", code: "Numpad7", metaKey: true }, { ...apple, applicationKeypad: true }),
    "\x1BOw",
  );
});

test("prompt jumps use Cmd+Up/Down on Apple keyboards and Ctrl+Shift+Page Up/Down elsewhere", () => {
  const apple = { appleKeyboard: true };
  assert.equal(terminalPromptJumpDirection({ key: "ArrowUp", metaKey: true }, apple), -1);
  assert.equal(terminalPromptJumpDirection({ key: "ArrowDown", metaKey: true }, apple), 1);
  assert.equal(terminalPromptJumpDirection({ key: "ArrowUp", metaKey: true, shiftKey: true }, apple), 0, "Cmd+Shift+Up moves windows");
  assert.equal(terminalPromptJumpDirection({ key: "ArrowUp", metaKey: true }, {}), 0, "Meta+Up off an Apple keyboard");
  assert.equal(terminalPromptJumpDirection({ key: "ArrowUp" }, apple), 0);
  for (const options of [{}, apple]) {
    assert.equal(terminalPromptJumpDirection({ key: "PageUp", ctrlKey: true, shiftKey: true }, options), -1);
    assert.equal(terminalPromptJumpDirection({ key: "PageDown", ctrlKey: true, shiftKey: true }, options), 1);
  }
  assert.equal(terminalPromptJumpDirection({ key: "PageUp", ctrlKey: true }, {}), 0);
  assert.equal(terminalPromptJumpDirection({ key: "PageUp", ctrlKey: true, shiftKey: true, altKey: true }, {}), 0);
});

test("Shift alone gives Ghostty's sequences for keys ghostty-web would send plain", () => {
  const shift = (key, code = key, extra = {}) => terminalShiftedKeySequence({ key, code, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, ...extra });
  assert.equal(shift("Tab"), "\x1B[Z", "backtab");
  assert.equal(shift("Home"), "\x1B[1;2H");
  assert.equal(shift("End"), "\x1B[1;2F");
  assert.equal(shift("Insert"), "\x1B[2;2~");
  assert.equal(shift("Delete"), "\x1B[3;2~");
  assert.equal(shift("PageUp"), "\x1B[5;2~");
  assert.equal(shift("PageDown"), "\x1B[6;2~");
  assert.equal(shift("F1"), "\x1B[1;2P");
  assert.equal(shift("F3"), "\x1B[13;2~", "not CSI 1;2R, which reads as a cursor position report");
  assert.equal(shift("F4"), "\x1B[1;2S");
  assert.equal(shift("F5"), "\x1B[15;2~");
  assert.equal(shift("F12"), "\x1B[24;2~");
  assert.equal(shift("Enter"), "\x1B[27;2;13~", "Shift+Enter, told apart from Enter as in Ghostty");
  assert.equal(shift("Escape"), "\x1B[27;2;27~");
  for (const key of ["Backspace", "ArrowUp", "A", "Clear"]) {
    assert.equal(shift(key), null, `${key} is left to ghostty-web`);
  }
  assert.equal(shift("Home", "Numpad7"), null, "numpad keys are terminalNavigationSequence's");
  assert.equal(shift("Tab", "Tab", { shiftKey: false }), null, "Tab alone stays a tab");
  for (const modifier of ["ctrlKey", "altKey", "metaKey"]) {
    assert.equal(shift("Tab", "Tab", { [modifier]: true }), null, `Shift with ${modifier} goes elsewhere`);
  }
  assert.equal(terminalShiftedKeySequence(null), null);
});

test("Command+Up/Down are Page Up/Down in full-screen programs and prompt jumps at the shell", () => {
  const command = (key, extra = {}) => ({ key, code: key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
  const apple = { appleKeyboard: true };
  assert.equal(terminalCommandArrowSequence(command("ArrowUp"), { ...apple, alternateScreen: true }), "\x1B[5~");
  assert.equal(terminalCommandArrowSequence(command("ArrowDown"), { ...apple, alternateScreen: true }), "\x1B[6~");
  assert.equal(terminalPromptJumpDirection(command("ArrowUp"), { ...apple, alternateScreen: true }), 0);
  assert.equal(terminalCommandArrowSequence(command("ArrowUp"), apple), null, "at the shell");
  assert.equal(terminalPromptJumpDirection(command("ArrowUp"), apple), -1);
  assert.equal(terminalPromptJumpDirection(command("ArrowDown"), apple), 1);
  assert.equal(terminalCommandArrowSequence(command("ArrowLeft"), { ...apple, alternateScreen: true }), "\x1B[H", "Command+Left stays Home");
  assert.equal(terminalCommandArrowSequence(command("ArrowUp", { shiftKey: true }), { ...apple, alternateScreen: true }), null);
  assert.equal(terminalCommandArrowSequence(command("ArrowUp"), { alternateScreen: true }), null, "not on other keyboards");
});
