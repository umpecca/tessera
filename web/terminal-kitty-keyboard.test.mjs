import assert from "node:assert/strict";
import test from "node:test";

import { ghosttyKeyCodes, terminalKittyKeyEvent } from "./terminal-kitty-keyboard.mjs";

const key = (fields) => ({ key: "", code: "", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...fields });

test("key codes follow Ghostty's numbering, including keys ghostty-web numbers one off", () => {
  assert.equal(ghosttyKeyCodes.KeyA, 20);
  assert.equal(ghosttyKeyCodes.Digit0, 6);
  assert.equal(ghosttyKeyCodes.Enter, 58);
  assert.equal(ghosttyKeyCodes.ArrowUp, 78);
  assert.equal(ghosttyKeyCodes.Numpad0, 80);
  assert.equal(ghosttyKeyCodes.Escape, 120);
  assert.equal(ghosttyKeyCodes.F25, 145);
  assert.equal(ghosttyKeyCodes.Fn, 146);
  assert.equal(ghosttyKeyCodes.PrintScreen, 148);
  assert.equal(ghosttyKeyCodes.Paste, 175);
  assert.equal(Object.keys(ghosttyKeyCodes).length, 175);
});

test("text, the unshifted key and the modifiers Shift spent on it", () => {
  assert.deepEqual(terminalKittyKeyEvent(key({ key: "a", code: "KeyA" })),
    { action: 1, key: 20, mods: 0, consumedMods: 0, composing: false, utf8: "a", unshiftedCodepoint: 97 });
  assert.deepEqual(terminalKittyKeyEvent(key({ key: "A", code: "KeyA", shiftKey: true })),
    { action: 1, key: 20, mods: 1, consumedMods: 1, composing: false, utf8: "A", unshiftedCodepoint: 97 });
  const bang = terminalKittyKeyEvent(key({ key: "!", code: "Digit1", shiftKey: true }));
  assert.deepEqual([bang.utf8, bang.unshiftedCodepoint, bang.consumedMods], ["!", 49, 1], "Shift+1 is 1 unshifted");
  const ctrlI = terminalKittyKeyEvent(key({ key: "i", code: "KeyI", ctrlKey: true }));
  assert.deepEqual([ctrlI.key, ctrlI.mods, ctrlI.consumedMods, ctrlI.unshiftedCodepoint], [28, 2, 0, 105]);
  const azerty = terminalKittyKeyEvent(key({ key: "a", code: "KeyQ" }));
  assert.equal(azerty.unshiftedCodepoint, 97, "the layout's character, not the US one");
  const enter = terminalKittyKeyEvent(key({ key: "Enter", code: "Enter", shiftKey: true }));
  assert.deepEqual([enter.key, enter.mods, enter.utf8, enter.unshiftedCodepoint], [58, 1, "", 0]);
  const caps = terminalKittyKeyEvent(key({ key: "A", code: "KeyA", getModifierState: (lock) => lock === "CapsLock" }));
  assert.deepEqual([caps.mods, caps.unshiftedCodepoint], [16, 97]);
});

test("Option is Alt on an Apple keyboard, not the character it would type", () => {
  const option = terminalKittyKeyEvent(key({ key: "å", code: "KeyA", altKey: true }), { appleKeyboard: true });
  assert.deepEqual([option.key, option.mods, option.unshiftedCodepoint, option.utf8], [20, 4, 97, "å"]);
  const alt = terminalKittyKeyEvent(key({ key: "a", code: "KeyA", altKey: true }));
  assert.deepEqual([alt.mods, alt.unshiftedCodepoint], [4, 97]);
});

test("Command, Home and End on an Apple keyboard, and numpad navigation", () => {
  const apple = { appleKeyboard: true };
  assert.equal(terminalKittyKeyEvent(key({ key: "s", code: "KeyS", metaKey: true }), apple), null, "Command+S never reaches the program");
  assert.equal(terminalKittyKeyEvent(key({ key: "Meta", code: "MetaLeft", metaKey: true }), apple), null);
  const commandLeft = terminalKittyKeyEvent(key({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }), apple);
  assert.deepEqual([commandLeft.key, commandLeft.mods], [71, 0], "Command+Left is Home");
  const shiftCommandRight = terminalKittyKeyEvent(key({ key: "ArrowRight", code: "ArrowRight", metaKey: true, shiftKey: true }), apple);
  assert.deepEqual([shiftCommandRight.key, shiftCommandRight.mods], [69, 1], "Shift+Command+Right is Shift+End");
  const globe = terminalKittyKeyEvent(key({ key: "PageDown", code: "ArrowDown", metaKey: true }), apple);
  assert.deepEqual([globe.key, globe.mods], [73, 0], "Globe+Down is Page Down, without the Command WebKit adds");
  const superKey = terminalKittyKeyEvent(key({ key: "s", code: "KeyS", metaKey: true }));
  assert.equal(superKey.mods, 8, "elsewhere the Windows key is Super");
  const numpadHome = terminalKittyKeyEvent(key({ key: "Home", code: "Numpad7" }));
  assert.equal(numpadHome.key, 114, "Num Lock off");
  assert.equal(terminalKittyKeyEvent(key({ key: "7", code: "Numpad7" })).key, 87);
});

test("releases, repeats, dead keys and keys without a code", () => {
  const release = terminalKittyKeyEvent(key({ key: "a", code: "KeyA" }), { action: "release" });
  assert.deepEqual([release.action, release.utf8, release.unshiftedCodepoint], [0, "", 97]);
  assert.equal(terminalKittyKeyEvent(key({ key: "a", code: "KeyA" }), { action: "repeat" }).action, 2);
  const dead = terminalKittyKeyEvent(key({ key: "Dead", code: "KeyE", altKey: true }), { appleKeyboard: true });
  assert.deepEqual([dead.composing, dead.utf8], [true, ""]);
  const typed = terminalKittyKeyEvent(key({ key: "é", code: "" }));
  assert.deepEqual([typed.key, typed.utf8], [0, "é"], "text from a key with no code still goes");
  assert.equal(terminalKittyKeyEvent(key({ key: "Unidentified", code: "" })), null);
  assert.equal(terminalKittyKeyEvent(null), null);
});
