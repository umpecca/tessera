import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function appFunction(name, context) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}\n", start) + 2;
  return vm.runInNewContext(`(${source.slice(start, end)})`, context);
}

test("Operator defaults use unsuffixed titles and other themes retain their naming", () => {
  const context = {
    themeID: "operator", rectangles: [{ title: "Terminal 2" }],
    browserPaneKind: "browser", vncPaneKind: "vnc",
  };
  const title = appFunction("defaultPaneTitle", context);
  assert.equal(title("terminal"), "Terminal");
  context.themeID = "studio";
  assert.equal(title("terminal"), "Terminal 3");
  assert.equal(context.rectangles[0].title, "Terminal 2", "saved titles are never rewritten");
});

test("closing a live terminal can be canceled and confirmed close ends its managed shell", () => {
  let accepted = false;
  const destroyed = [];
  const close = appFunction("closeWindowFromTitleBar", {
    window: { confirm: () => accepted },
    destroyRectangle: (rect, options) => destroyed.push([rect, options.closeServerTerminal]),
  });
  const terminal = { kind: "terminal", title: "Build console", terminalStatus: null };
  close(terminal);
  assert.equal(destroyed.length, 0);
  accepted = true;
  close(terminal);
  assert.deepEqual(destroyed, [[terminal, true]]);
});

test("closing browser panes and already exited terminals needs no shell confirmation", () => {
  const destroyed = [];
  const close = appFunction("closeWindowFromTitleBar", {
    window: { confirm() { assert.fail("no live shell to confirm"); } },
    destroyRectangle: rect => destroyed.push(rect.kind),
  });
  close({ kind: "browser" });
  close({ kind: "terminal", terminalStatus: { state: "exited" } });
  assert.deepEqual(destroyed, ["browser", "terminal"]);
});

test("theme switching clears transient wobble and refits the existing terminal views", () => {
  const calls = [];
  const rect = {};
  const context = {
    themes: { operator: {}, studio: {} }, themeID: "studio", defaultThemeID: "studio",
    currentUser: "alice", window: { tesseraStartup: { cacheTheme: (user, theme) => calls.push(`cache:${user}:${theme}`) } },
    windowWobble: { stop: () => calls.push("stop") }, rectangles: [rect],
    document: { documentElement: { dataset: {} } }, setOLEDMoveMode() {},
    reflowDockedPanesForTheme: () => calls.push("reflow"),
    requestTerminalFit: pane => { assert.equal(pane, rect); calls.push("fit"); },
    scheduleTerminalVisibilityUpdate: () => calls.push("visibility"),
    scheduleUserSettingsSave: () => calls.push("save"),
  };
  appFunction("applyTheme", context)("operator");
  assert.equal(context.document.documentElement.dataset.theme, "operator");
  assert.deepEqual(calls, ["stop", "cache:alice:operator", "reflow", "fit", "visibility", "save"]);
});

test("Operator docking is flush and maximization resets a scrolled desktop", () => {
  const context = { themeID: "operator", tabHeight: 24 };
  const inset = appFunction("dockTopInset", context);
  assert.equal(inset(), 0);
  context.themeID = "studio";
  assert.equal(inset(), 24);
  context.themeID = "oled-terminal";
  assert.equal(inset(), 0);
  for (const themeID of ["operator", "studio"]) {
    const board = { scrollLeft: 498, scrollTop: 120, getBoundingClientRect: () => ({ width: 390, height: 844 }) };
    const window = { scrollX: 0, scrollY: 0, scrollTo() { assert.fail("the page was not scrolled"); } };
    const context = { themeID, board, window, setRectangle: (_, box) => geometry = { ...box } };
    context.pinWorkspaceScroll = appFunction("pinWorkspaceScroll", context);
    let geometry;
    appFunction("applyFullGeometry", context)({});
    assert.deepEqual(geometry, { x: 0, y: 0, width: 390, height: 844 });
    assert.equal(board.scrollLeft, 0, themeID);
    assert.equal(board.scrollTop, 0, themeID);
  }
});

test("a page or board scrolled by focus is put back", () => {
  const scrolls = [];
  const window = { scrollX: 0, scrollY: 54, scrollTo: (x, y) => scrolls.push([x, y]) };
  const board = { scrollLeft: 0, scrollTop: 0 };
  const pin = appFunction("pinWorkspaceScroll", { window, board });
  pin();
  assert.deepEqual(scrolls, [[0, 0]], "iPadOS scrolled the page for the shortcut bar");
  window.scrollY = 0; board.scrollTop = 30;
  pin();
  assert.deepEqual([scrolls.length, board.scrollTop], [1, 0], "the board, without touching the page");
  pin();
  assert.equal(scrolls.length, 1, "nothing to do");
});

test("Cascade Arrange includes Operator title bars while retaining the other themes' inset", () => {
  for (const [themeID, inset] of [["operator", 0], ["studio", 24], ["oled-terminal", 24]]) {
    const rect = { id: "one", kind: "terminal", x: 40, y: 70, width: 300, height: 200 };
    appFunction("arrangeWindowsOut", {
      themeID, tabHeight: 24, rectangles: [rect], arrangeOutSnapshot: null, isArrangingWindows: false,
      board: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
      rectangleBox: pane => ({ x: pane.x, y: pane.y, width: pane.width, height: pane.height }),
      clearFullState() {}, scheduleWorkspaceSave() {},
      setRectangle: (pane, box) => Object.assign(pane, box),
    })();
    assert.equal(rect.x, 0);
    assert.equal(rect.y, inset, themeID);
    assert.equal(rect.width, 800);
    assert.equal(rect.height, 600 - inset, themeID);
  }
});
