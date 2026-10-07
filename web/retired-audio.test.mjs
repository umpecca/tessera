import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("loading a legacy workspace discards Audio panes and retains the remaining panes", () => {
  const rectangles = [];
  let active;
  const context = {
    isLoadingWorkspace: false, workspaceID: "", workspaceRevision: "", workspaceSaveSuspended: false,
    workspaceNeedsRevalidation: false, workspaceSaveQueued: false, workspaceConflictModal: {},
    rectangles, nextZIndex: 1, tabHeight: 24,
    setWorkspaceStatus() {}, applyWorkspaceBackground() {}, clearRectanglesForLoad() {},
    createRectangle: (x, y, width, height, options) => {
      const rect = { ...options, x, y, width, height };
      rectangles.push(rect);
      return rect;
    },
    reflowDockedPanesForTheme() {}, updateDeskbar() {}, parseRestoreBox: () => null,
    activePaneOnLoad: (panes, id) => panes.find(pane => pane.id === id) || panes[0],
    setActivePane: rect => { active = rect; },
  };
  const start = source.indexOf("function loadWorkspace(");
  const end = source.indexOf("\n}\n", start) + 2;
  const load = vm.runInNewContext(`(${source.slice(start, end)})`, context);
  load({ id: "legacy", activePaneId: "old-audio", panes: [
    { id: "old-audio", kind: "audio" },
    { id: "terminal", kind: "terminal", title: "Build", x: 123 },
    { id: "notes", kind: "worksheet", bufferText: "preserve notes" },
  ] });
  assert.deepEqual(rectangles.map(pane => pane.id), ["terminal", "notes"]);
  assert.equal(rectangles[0].x, 123);
  assert.equal(rectangles[1].text, "preserve notes");
  assert.equal(active.id, "terminal");
  assert.equal(context.isLoadingWorkspace, false);
});
