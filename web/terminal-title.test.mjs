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
    deskbarPanel: { hidden: true }, windowList: { hidden: true },
    updateDeskbar() { context.updates++; }, scheduleWorkspaceSave() { context.saves++; },
    updates: 0, saves: 0,
  };
  const start = source.indexOf("function applyTerminalWindowTitle(");
  const labelsStart = source.indexOf("function updatePaneTitleLabels(");
  const end = source.indexOf("\n}\n", labelsStart) + 2;
  const apply = vm.runInNewContext(`${source.slice(start, end)}; applyTerminalWindowTitle`, context);
  return { rect, name, context, apply: title => apply(rect, title) };
}

test("application titles update the pane and open switcher as text without saving or rebuilding lists", () => {
  const f = fixture();
  f.apply("<b>vim — 界</b>");
  assert.equal(f.rect.title, "<b>vim — 界</b>");
  assert.equal(f.rect.titleInput.value, f.rect.title);
  assert.equal(f.name.textContent, f.rect.title);
  assert.equal(windowSwitcherEntries([f.rect], f.rect.id)[0].name, f.rect.title);
  f.apply(f.rect.title); f.apply(""); f.apply("   ");
  f.rect.title = "Manual name";
  f.apply("<b>vim — 界</b>");
  assert.equal(f.rect.title, "<b>vim — 界</b>", "a subsequent request resumes automatic naming");
  for (const frame of ["◐ Working", "◓ Working", "◑ Working", "◒ Working"]) f.apply(frame);
  assert.equal(f.rect.title, "◒ Working");
  assert.equal(f.context.saves, 0, "animated program titles never schedule workspace saves");
  assert.equal(f.context.updates, 0, "open lists are relabeled in place, not rebuilt");
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
  assert.equal(f.rect.title, "Terminal");
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

test("application titles relabel open Deskbar and window list rows in place", () => {
  const f = fixture();
  const control = (attrs = {}) => ({ textContent: "", title: "", dataset: {}, ...attrs, setAttribute(k, v) { this[k] = v; } });
  const deskButton = control();
  const listName = control();
  const moves = [control({ dataset: { windowListAction: "up" } }), control({ dataset: { windowListAction: "down" } })];
  const deskRow = { dataset: { paneId: f.rect.id }, querySelector: () => deskButton };
  const otherRow = { dataset: { paneId: "other" }, querySelector: () => assert.fail("other panes are untouched") };
  const listRow = { dataset: { paneId: f.rect.id }, querySelector: () => listName, querySelectorAll: () => moves };
  Object.assign(f.context, {
    deskbarPanel: { hidden: false, querySelectorAll: () => [otherRow, deskRow] },
    windowList: { hidden: false }, windowListEntries: [{}, f.rect],
    windowListItems: { querySelectorAll: () => [listRow] },
    workspaceMenuLabel: rect => `${rect.title} [terminal]`,
  });
  f.rect.cwd = "/repo";
  f.apply("lazygit");
  assert.equal(deskButton.textContent, "lazygit [terminal]");
  assert.equal(deskButton.title, "lazygit [terminal] (/repo)");
  assert.equal(listName.textContent, "2. lazygit [terminal]");
  assert.equal(listName["aria-label"], listName.textContent);
  assert.deepEqual(moves.map(move => move["aria-label"]), ["Move lazygit [terminal] up", "Move lazygit [terminal] down"]);
  assert.equal(f.context.updates, 0);
});
