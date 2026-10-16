import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
function appFunctions(names, context) {
  const bodies = names.map((name) => {
    const start = source.indexOf(`function ${name}(`);
    return source.slice(start, source.indexOf("\n}\n", start) + 2);
  });
  vm.runInNewContext(bodies.join("\n"), context);
  return context;
}

function workspace(bounds) {
  const pane = (id, isFull) => ({
    id, kind: "terminal", isFull, minimized: false, x: 0, y: 0, width: 834, height: 1178,
    element: { style: {} },
  });
  const context = {
    themeID: "studio", isArrangingWindows: false, arrangeOutSnapshot: null, saves: 0, fits: 0,
    board: { getBoundingClientRect: () => bounds },
    rectangles: [pane("full", true), pane("floating", false)],
    scheduleTerminalVisibilityUpdate() {}, requestTerminalFit: () => context.fits++,
    scheduleWorkspaceSave: () => context.saves++,
  };
  return appFunctions(["setRectangle", "applyFullGeometry", "reapplyFullGeometryForViewport"], context);
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
