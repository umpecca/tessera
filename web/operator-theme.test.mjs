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
    fileBrowserPaneKind: "file-browser", textEditorPaneKind: "text-editor",
    browserPaneKind: "browser", vncPaneKind: "vnc",
  };
  const title = appFunction("defaultPaneTitle", context);
  assert.equal(title("terminal"), "Terminal");
  assert.equal(title("worksheet"), "Worksheet");
  assert.equal(title("file-browser"), "File Browser");
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

test("closing editor panes and already exited terminals needs no shell confirmation", () => {
  const destroyed = [];
  const close = appFunction("closeWindowFromTitleBar", {
    window: { confirm() { assert.fail("no live shell to confirm"); } },
    destroyRectangle: rect => destroyed.push(rect.kind),
  });
  close({ kind: "text-editor" });
  close({ kind: "terminal", terminalStatus: { state: "exited" } });
  assert.deepEqual(destroyed, ["text-editor", "terminal"]);
});

test("theme switching clears transient wobble and refits the existing editor and terminal views", () => {
  const calls = [];
  const rect = { editor: { requestMeasure: () => calls.push("measure") } };
  const context = {
    themes: { operator: {}, studio: {} }, themeID: "studio", defaultThemeID: "studio",
    windowWobble: { stop: () => calls.push("stop") }, rectangles: [rect],
    document: { documentElement: { dataset: {} } }, setOLEDMoveMode() {},
    reflowDockedPanesForTheme: () => calls.push("reflow"),
    requestTerminalFit: pane => { assert.equal(pane, rect); calls.push("fit"); },
    scheduleTerminalVisibilityUpdate: () => calls.push("visibility"),
    scheduleUserSettingsSave: () => calls.push("save"),
  };
  appFunction("applyTheme", context)("operator");
  assert.equal(context.document.documentElement.dataset.theme, "operator");
  assert.deepEqual(calls, ["stop", "reflow", "measure", "fit", "visibility", "save"]);
});

test("Operator docking is flush and maximization resets a scrolled desktop", () => {
  const context = { themeID: "operator", tabHeight: 24 };
  const inset = appFunction("dockTopInset", context);
  assert.equal(inset(), 0);
  context.themeID = "studio";
  assert.equal(inset(), 24);
  context.themeID = "oled-terminal";
  assert.equal(inset(), 0);
  const board = { scrollLeft: 498, scrollTop: 120, getBoundingClientRect: () => ({ width: 390, height: 844 }) };
  let geometry;
  appFunction("applyFullGeometry", {
    themeID: "operator", board, setRectangle: (_, box) => geometry = { ...box },
  })({});
  assert.deepEqual(geometry, { x: 0, y: 0, width: 390, height: 844 });
  assert.equal(board.scrollLeft, 0);
  assert.equal(board.scrollTop, 0);
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
