import assert from "node:assert/strict";
import test from "node:test";
import { describeKeyEvent, KeyReadout, keyModifierNames, keyReadoutShouldPreventKeydown } from "./key-readout.mjs";

const keydown = (key, code, extra = {}) => ({ type: "keydown", key, code, keyCode: 0, ...extra });

test("names modifiers as an Apple keyboard labels them", () => {
  assert.deepEqual(keyModifierNames({ ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }), ["Ctrl", "Option", "Shift", "Cmd"]);
  assert.deepEqual(keyModifierNames({ getModifierState: name => name === "Fn" }), ["Fn"]);
  assert.deepEqual(keyModifierNames({}), []);
});

test("describes keydown with key, code, keyCode and flags", () => {
  assert.equal(
    describeKeyEvent(keydown("ArrowLeft", "ArrowLeft", { metaKey: true, keyCode: 37 })),
    'keydown Cmd key "ArrowLeft" · code ArrowLeft · keyCode 37',
  );
  assert.equal(
    describeKeyEvent(keydown("Backspace", "Backspace", { keyCode: 8, repeat: true })),
    'keydown key "Backspace" · code Backspace · keyCode 8 · repeat',
  );
  assert.equal(
    describeKeyEvent({ type: "keydown", key: "Unidentified", code: "", isComposing: true }),
    'keydown key "Unidentified" · code (none) · keyCode ? · composing',
  );
});

test("describes beforeinput by its edit", () => {
  assert.equal(describeKeyEvent({ type: "beforeinput", inputType: "deleteContentForward", data: null }), "beforeinput deleteContentForward");
  assert.equal(describeKeyEvent({ type: "beforeinput", inputType: "insertText", data: "é" }), 'beforeinput insertText data "é"');
  assert.equal(describeKeyEvent({ type: "beforeinput" }), "beforeinput (no inputType)");
});

test("keeps the newest lines first and copies them oldest first", () => {
  const readout = new KeyReadout(2);
  readout.record(keydown("a", "KeyA"));
  readout.record(keydown("b", "KeyB"));
  readout.record(keydown("c", "KeyC"));
  assert.deepEqual(readout.entries.map(entry => entry.slice(0, 15)), ['keydown key "c"', 'keydown key "b"']);
  assert.equal(readout.text("header").split("\n").map(line => line.slice(0, 15)).join("|"), 'header|keydown key "b"|keydown key "c"');
  readout.clear();
  assert.equal(readout.text("header"), "header");
});

test("cancels only Command and Control character shortcuts", () => {
  assert.equal(keyReadoutShouldPreventKeydown(keydown("r", "KeyR", { metaKey: true })), true);
  assert.equal(keyReadoutShouldPreventKeydown(keydown("w", "KeyW", { ctrlKey: true })), true);
  assert.equal(keyReadoutShouldPreventKeydown(keydown("ArrowLeft", "ArrowLeft", { metaKey: true })), false);
  assert.equal(keyReadoutShouldPreventKeydown(keydown("Backspace", "Backspace", { ctrlKey: true })), false);
  assert.equal(keyReadoutShouldPreventKeydown(keydown("a", "KeyA")), false);
  assert.equal(keyReadoutShouldPreventKeydown(keydown("Tab", "Tab")), false);
});
