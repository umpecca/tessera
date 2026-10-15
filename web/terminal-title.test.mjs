import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { windowSwitcherEntries } from "./window-switcher.mjs";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
function fixture() {
  const rect = { id: "terminal", kind: "terminal", title: "Terminal", titleInput: { value: "Terminal", readOnly: true } };
  const name = { textContent: "Terminal" };
  const context = {
    rectangles: [rect], renameWindowModal: { hidden: true, dataset: {} },
    windowSwitcher: { hidden: false },
    windowSwitcherList: { children: [{ dataset: { paneId: rect.id }, querySelector: () => name }] },
    updateDeskbar() { context.updates++; }, scheduleWorkspaceSave() { context.saves++; },
    updates: 0, saves: 0,
  };
  const start = source.indexOf("function applyTerminalWindowTitle(");
  const end = source.indexOf("\n}\n", start) + 2;
  const apply = vm.runInNewContext(`(${source.slice(start, end)})`, context);
  return { rect, name, context, apply: title => apply(rect, title) };
}

test("application titles update the pane and open switcher as text and avoid repeated saves", () => {
  const f = fixture();
  f.apply("<b>vim — 界</b>");
  assert.equal(f.rect.title, "<b>vim — 界</b>");
  assert.equal(f.rect.titleInput.value, f.rect.title);
  assert.equal(f.name.textContent, f.rect.title);
  assert.equal(windowSwitcherEntries([f.rect], f.rect.id)[0].name, f.rect.title);
  assert.equal(f.context.updates, 1);
  assert.equal(f.context.saves, 1);
  f.apply(f.rect.title); f.apply(""); f.apply("   ");
  assert.equal(f.context.saves, 1);
  f.rect.title = "Manual name";
  f.apply("<b>vim — 界</b>");
  assert.equal(f.rect.title, "<b>vim — 界</b>", "a subsequent request resumes automatic naming");
  assert.equal(f.context.saves, 2);
});

test("title following protects both title editors and only updates existing terminal panes", () => {
  const f = fixture();
  f.rect.titleInput.readOnly = false;
  f.rect.titleInput.value = "Typing";
  f.apply("App title");
  assert.equal(f.rect.titleInput.value, "Typing");
  assert.equal(f.rect.title, "Terminal");
  f.rect.titleInput.readOnly = true;
  f.context.renameWindowModal = { hidden: false, dataset: { paneId: f.rect.id } };
  f.apply("App title");
  assert.equal(f.context.saves, 0);
  f.context.renameWindowModal.dataset.paneId = "other";
  f.apply("App title");
  assert.equal(f.rect.title, "App title", "editing another pane does not block this one");
  f.rect.minimized = true;
  f.apply("Background app");
  assert.equal(f.name.textContent, "Background app (minimized)");
  f.rect.kind = "browser"; f.apply("Ignore");
  assert.equal(f.rect.title, "Background app");
  f.rect.kind = "terminal"; f.context.rectangles = []; f.apply("Ignore");
  assert.equal(f.rect.title, "Background app");
});
