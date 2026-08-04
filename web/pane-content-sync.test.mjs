import assert from "node:assert/strict";
import test from "node:test";

import { paneContentFields } from "./pane-content-sync.mjs";

test("a pane with no saved content sends both documents", () => {
  assert.deepEqual(paneContentFields({ bufferText: "hello", editorTabs: "{}" }, undefined), {
    bufferText: "hello",
    editorTabs: "{}",
  });
});

test("unchanged documents are flagged instead of resent", () => {
  const content = { bufferText: "hello", editorTabs: "{}" };
  assert.deepEqual(paneContentFields(content, { ...content }), {
    bufferTextUnchanged: true,
    editorTabsUnchanged: true,
  });
});

test("only the changed document is resent", () => {
  const saved = { bufferText: "hello", editorTabs: "{}" };
  assert.deepEqual(paneContentFields({ bufferText: "hello there", editorTabs: "{}" }, saved), {
    bufferText: "hello there",
    editorTabsUnchanged: true,
  });
  assert.deepEqual(paneContentFields({ bufferText: "hello", editorTabs: `{"active":1}` }, saved), {
    bufferTextUnchanged: true,
    editorTabs: `{"active":1}`,
  });
});

test("clearing a document is sent as an empty string, not flagged", () => {
  assert.deepEqual(paneContentFields({ bufferText: "", editorTabs: "" }, { bufferText: "hello", editorTabs: "{}" }), {
    bufferText: "",
    editorTabs: "",
  });
});
