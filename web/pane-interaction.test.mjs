import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
function appFunction(name, globals) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}\n", start) + 2;
  const prefix = source.slice(start - 6, start) === "async " ? "async " : "";
  return vm.runInNewContext(`(${prefix}${source.slice(start, end)})`, globals);
}

test("dialogs block destructive shortcuts from both the document and iframe resolver", () => {
  const names = ["settingsModal", "renameWindowModal", "sessionsModal", "sessionActionModal",
    "serverUpdateModal", "serverConnectionModal", "workspaceConflictModal", "helpModal",
    "directoryBrowser", "userSelect", "commandPalette", "windowList"];
  const globals = Object.fromEntries(names.map((name) => [name, { hidden: true }]));
  let destroyed = 0;
  globals.destroyActivePane = () => destroyed++;
  globals.toggleWindowList = () => {};
  globals.toggleCommandPalette = () => {};
  const resolve = appFunction("paneShortcutAction", globals);
  const keys = { ctrlKey: true, key: "Backspace" };
  resolve(keys).run();
  assert.equal(destroyed, 1);
  for (const name of names) {
    globals[name].hidden = false;
    assert.equal(resolve(keys), null, name);
    assert.equal(resolve({ ctrlKey: true, key: "Enter" }), null, name);
    globals[name].hidden = true;
  }
  globals.commandPalette.hidden = false;
  assert.ok(resolve({ ctrlKey: true, key: "k" }), "palette toggle remains available");
});

test("a terminal removed while its dependencies load never opens or connects", async () => {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const rect = { kind: "terminal", terminalContainer: {}, fontSize: 14 };
  const rectangles = [rect];
  const start = appFunction("startTerminal", {
    rectangles, document: { fonts: {} }, terminalFont: "test",
    loadGhosttyModule: () => ready,
    loadTerminalFont: async () => {},
    console: { warn(error) { assert.fail(String(error)); } },
  });
  const pending = start(rect);
  rectangles.splice(0);
  release({ Terminal: class { constructor() { assert.fail("opened a removed terminal"); } } });
  await pending;
  assert.equal(rect.terminal, undefined);
});

test("exit saves accept their own pending revision and carry reverted content", () => {
  let request;
  const exit = appFunction("saveWorkspaceOnExit", {
    isLoadingWorkspace: false, workspaceSaveSuspended: false, workspaceNeedsRevalidation: false,
    saveTimer: 1, workspaceSavePromise: {}, workspaceInFlightRevision: "pending-revision",
    workspaceID: "test", maxKeepaliveSaveBytes: 1000, TextEncoder,
    window: { clearTimeout() {} }, newWorkspaceRevision: () => "newrevision",
    workspaceSavePayload: () => ({
      body: { revision: "loaded-revision", panes: [{ id: "editor", bufferTextUnchanged: true, editorTabsUnchanged: true }] },
      contentByPaneID: new Map([["editor", { bufferText: "original text", editorTabs: "" }]]),
    }),
    fetch(url, options) { request = options; return Promise.resolve(); },
  });
  exit();
  const body = JSON.parse(request.body);
  assert.equal(body.revision, "loaded-revision");
  assert.equal(body.alternateRevision, "pending-revision");
  assert.equal(body.nextRevision, "newrevision");
  assert.equal(body.panes[0].bufferText, "original text");
  assert.equal(body.panes[0].bufferTextUnchanged, undefined);
  assert.equal(body.panes[0].editorTabsUnchanged, undefined);
});

test("moving panes avoids size measurements, while resize and initial layout still measure", () => {
  let measurements = 0;
  let fits = 0;
  let saves = 0;
  const setRectangle = appFunction("setRectangle", {
    requestTerminalFit() { fits++; },
    scheduleWorkspaceSave() { saves++; },
    isArrangingWindows: false,
    arrangeOutSnapshot: null,
  });
  const rect = { x: 10, y: 20, width: 300, height: 200,
    element: { style: {} }, editor: { requestMeasure() { measurements++; } } };
  setRectangle(rect, rect);
  assert.equal(rect.element.style.width, "300px");
  assert.deepEqual([measurements, fits, saves], [1, 1, 1]);
  setRectangle(rect, { x: 30, y: 40, width: 300, height: 200 });
  assert.equal(rect.element.style.transform, "translate(30px, 40px)");
  assert.deepEqual([measurements, fits, saves], [1, 1, 2]);
  setRectangle(rect, { x: 30.1, y: 40.1, width: 300.1, height: 200.1 });
  assert.deepEqual([measurements, fits, saves], [1, 1, 2]);
  setRectangle(rect, { x: 30, y: 40, width: 320, height: 210 });
  assert.equal(rect.element.style.width, "320px");
  assert.deepEqual([measurements, fits, saves], [2, 2, 3]);
});

test("refocusing the active frontmost pane preserves explicit focus without rebuilding UI", () => {
  let focuses = 0;
  const rect = { id: "active", element: { focus() { focuses++; } } };
  const setActivePane = appFunction("setActivePane", {
    rectangles: [rect], activePaneID: rect.id,
    paneNeedsRaise: () => false,
    focusPane() { focuses++; },
    clearActivePaneClass() { assert.fail("selection was rebuilt"); },
    updateDeskbar() { assert.fail("deskbar was rebuilt"); },
    scheduleWorkspaceSave() { assert.fail("redundant save"); },
  });
  setActivePane(rect, { raise: true });
  assert.equal(focuses, 0);
  setActivePane(rect, { focusEditor: true });
  setActivePane(rect, { focusElement: true });
  assert.equal(focuses, 2);
});
