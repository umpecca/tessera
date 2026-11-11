import { featureFixture } from "./application.test-support.mjs";
import assert from "node:assert/strict";

import test from "node:test";

function appFunctions(names, context) {
  const fixtureContext = featureFixture(names, context);
  return fixtureContext;
}

function workspace(bounds) {
  const pane = (id, isFull) => ({
    id, kind: "terminal", isFull, minimized: false, x: 0, y: 0, width: 834, height: 1178,
    element: { style: {} },
  });
  const context = {
    themeID: "studio", isArrangingWindows: false, arrangeOutSnapshot: null, saves: 0, fits: 0,
    board: { scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => bounds },
    window: { scrollX: 0, scrollY: 0 },
    rectangles: [pane("full", true), pane("floating", false)],
    scheduleTerminalVisibilityUpdate() {}, requestTerminalFit: () => context.fits++,
    scheduleWorkspaceSave: () => context.saves++,
  };
  return appFunctions(["setRectangle", "pinWorkspaceScroll", "applyFullGeometry", "reapplyFullGeometryForViewport"], context);
}

test("a viewport change refits maximized panes to this screen without saving", () => {
  const context = workspace({ width: 1512, height: 945 });
  context.reapplyFullGeometryForViewport();
  const [full, floating] = context.rectangles;
  assert.deepEqual([full.x, full.y, full.width, full.height], [0, 0, 1512, 945]);
  assert.equal(full.element.style.width, "1512px");
  assert.equal(floating.width, 834, "panes that are not maximized keep their box");
  assert.equal(context.fits, 1, "the refit terminal still measures its new grid");
  assert.equal(context.saves, 0);
});

test("maximizing a pane on purpose is still saved", () => {
  const context = workspace({ width: 1512, height: 945 });
  context.applyFullGeometry(context.rectangles[1]);
  assert.equal(context.rectangles[1].width, 1512);
  assert.equal(context.saves, 1);
});
