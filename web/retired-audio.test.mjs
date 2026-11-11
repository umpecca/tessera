import assert from "node:assert/strict";
import test from "node:test";
import { featureFixture } from "./application.test-support.mjs";

test("loading a legacy workspace discards Audio panes and retains the remaining panes", () => {
  const rectangles = [];
  let active;
  const context = {
    isLoadingWorkspace: false, workspaceID: "", workspacePersistence: { reset() {} }, workspaceConflictModal: {},
    rectangles, nextZIndex: 1, tabHeight: 24,
    setWorkspaceStatus() {}, applyWorkspaceBackground() {}, clearRectanglesForLoad() {},
    createRectangle: (x, y, width, height, options) => {
      const rect = { ...options, x, y, width, height };
      rectangles.push(rect);
      return rect;
    },
    reflowDockedPanesForTheme() {}, updateDeskbar() {}, parseRestoreBox: () => null, phoneView: { reset() {} },
    setActivePane: rect => { active = rect; },
  };
  const load = featureFixture(["loadWorkspace"], context).loadWorkspace;
  load({ id: "legacy", activePaneId: "old-audio", panes: [
    { id: "old-audio", kind: "audio" },
    { id: "terminal", kind: "terminal", title: "Build", x: 123 },
    { id: "notes", kind: "worksheet", bufferText: "preserve notes" },
  ] });
  assert.deepEqual(rectangles.map(pane => pane.id), ["terminal", "notes"]);
  assert.equal(rectangles[0].x, 123);
  assert.equal(rectangles[1].text, "preserve notes");
  assert.equal(active, undefined, "a removed Audio pane must not receive focus");
  assert.equal(context.isLoadingWorkspace, false);
});
