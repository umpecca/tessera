import test from "node:test";
import assert from "node:assert/strict";

import {
  clipboardItemsContent,
  describeHostClipboard,
  pastedImage,
  terminalPasteKeys,
  writeHostClipboardImage,
} from "./clipboard-image.mjs";

const imageFile = { type: "image/png", name: "screenshot.png" };

function transfer({ text = "", items = [], files = [] } = {}) {
  return { getData: type => (type === "text/plain" ? text : ""), items, files };
}

test("an image-only paste yields the image", () => {
  const item = { kind: "file", type: "image/png", getAsFile: () => imageFile };
  assert.equal(pastedImage(transfer({ items: [item] })), imageFile);
  assert.equal(pastedImage(transfer({ files: [imageFile] })), imageFile);
});

test("text wins over an image, and other files are not images", () => {
  const item = { kind: "file", type: "image/png", getAsFile: () => imageFile };
  assert.equal(pastedImage(transfer({ text: "https://example.com/a.png", items: [item] })), null);
  assert.equal(pastedImage(transfer({ files: [{ type: "application/pdf" }] })), null);
  assert.equal(pastedImage(null), null);
});

test("clipboard items prefer text, then an image", async () => {
  const blob = (value) => ({ text: async () => value });
  const textItem = { types: ["text/plain"], getType: async () => blob("hello") };
  const imageItem = { types: ["image/png"], getType: async () => imageFile };
  assert.deepEqual(await clipboardItemsContent([imageItem, textItem]), { text: "hello" });
  assert.deepEqual(await clipboardItemsContent([imageItem]), { image: imageFile });
  assert.equal(await clipboardItemsContent([]), null);
});

test("the paste key is ^V unless the program turned on the Kitty protocol", () => {
  assert.deepEqual(terminalPasteKeys({ kittyKeyboardFlags: () => 0 }), ["\x16"]);
  const encoded = [];
  const term = {
    kittyKeyboardFlags: () => 1,
    encodeKeyEvent: (fields, flags) => { encoded.push({ ...fields, flags }); return `key${encoded.length}`; },
  };
  assert.deepEqual(terminalPasteKeys(term), ["key1"]);
  assert.equal(encoded[0].action, 1, "press");
  assert.equal(encoded[0].unshiftedCodepoint, "v".codePointAt(0));
  assert.equal(encoded[0].mods, 2, "Ctrl alone (Ghostty numbers Ctrl 2)");
});

test("a program that asked for releases gets the release too", () => {
  const actions = [];
  const term = { kittyKeyboardFlags: () => 3, encodeKeyEvent: (fields) => { actions.push(fields.action); return "k"; } };
  assert.deepEqual(terminalPasteKeys(term), ["k", "k"]);
  assert.deepEqual(actions, [1, 0]);
});

test("a refused write carries the server's reason", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ available: false, session: "service", reason: "running as a service" }),
  });
  await assert.rejects(writeHostClipboardImage(imageFile, fetchImpl), (error) => {
    assert.equal(error.message, "running as a service");
    assert.equal(error.status.session, "service");
    return true;
  });
});

test("Diagnostics says whether enhanced copy/paste works and why not", () => {
  const now = Date.parse("2026-10-21T12:10:00Z");
  assert.equal(describeHostClipboard(null), "Checking…");
  assert.match(describeHostClipboard(null, { failed: true }), /did not answer/);
  assert.equal(describeHostClipboard({ available: false, reason: "no display" }), "Not available: no display");
  const working = { available: true, backend: "macOS pasteboard", session: "desktop" };
  assert.equal(describeHostClipboard(working), "Working (macOS pasteboard, desktop session). No image pasted yet.");
  assert.equal(
    describeHostClipboard({ ...working, lastWrite: { at: "2026-10-21T12:05:00Z", ok: true } }, { now }),
    "Working (macOS pasteboard, desktop session). Last image paste succeeded 5 min ago.",
  );
  assert.match(
    describeHostClipboard({ ...working, lastWrite: { at: "2026-10-21T12:09:59Z", ok: false, error: "busy" } }, { now }),
    /^Available, but the last image paste failed just now: busy$/,
  );
});
