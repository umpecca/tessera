import assert from "node:assert/strict";
import test from "node:test";

import {
  isTerminalCopyShortcut,
  terminalNavigationSequence,
  terminalPasteSource,
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
