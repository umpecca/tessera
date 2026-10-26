import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
function load(names, context) {
  vm.createContext(context);
  for (const name of names) {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf("\n}\n", start) + 2;
    assert.ok(start >= 0, name);
    vm.runInContext(source.slice(start, end), context);
  }
  return context;
}

test("a new terminal takes half the board each way, centered", () => {
  const context = load(["centeredPaneBox"], { tabHeight: 24, Math });
  const centeredPaneBox = (bounds) => ({ ...context.centeredPaneBox(bounds) });
  assert.deepEqual(centeredPaneBox({ width: 1600, height: 1000 }), { x: 400, y: 250, width: 800, height: 500 });
  assert.deepEqual(centeredPaneBox({ width: 1180, height: 820 }), { x: 295, y: 205, width: 590, height: 410 }, "an iPad");
  assert.deepEqual(centeredPaneBox({ width: 600, height: 380 }), { x: 120, y: 80, width: 360, height: 220 }, "a small window keeps a usable size");
  assert.deepEqual(centeredPaneBox({ width: 300, height: 200 }), { x: 0, y: 24, width: 300, height: 200 }, "never larger than the board");
});

test("New Terminal opens centered, or where the desktop was right-clicked", () => {
  const created = [];
  const context = load(["centeredPaneBox", "createTerminalPane"], {
    tabHeight: 24, Math, activeRect: null,
    board: { getBoundingClientRect: () => ({ width: 1600, height: 1000 }) },
    createRectangle: (x, y, width, height, options) => { const rect = { x, y, width, height, ...options }; created.push(rect); return rect; },
    clampIntoBoard() {}, setRectangle() {}, setActivePane() {}, scheduleWorkspaceSave() {},
  });
  context.createTerminalPane();
  context.createTerminalPane(null, { title: "Build" });
  context.createTerminalPane({ x: 300, y: 10 });
  assert.deepEqual(created.map(({ x, y, width, height }) => [x, y, width, height]), [
    [400, 250, 800, 500],
    [400, 250, 800, 500],
    [300, 24, 800, 500],
  ]);
  assert.equal(created[1].title, "Build");
});

test("New Browser and New VNC from the palette open centered at half the board; others keep their place", () => {
  const created = [];
  const context = load(["centeredPaneBox", "paneBox", "createBrowserPane", "createVNCPane"], {
    tabHeight: 24, Math, browserPaneKind: "browser", vncPaneKind: "vnc",
    board: { getBoundingClientRect: () => ({ width: 1600, height: 1000 }) },
    createRectangle: (x, y, width, height, options) => { const rect = { x, y, width, height, ...options }; created.push(rect); return rect; },
    clampIntoBoard() {}, setRectangle() {}, setActivePane() {}, scheduleWorkspaceSave() {},
  });
  context.createBrowserPane();
  context.createVNCPane();
  context.createBrowserPane({ x: 48, y: 64 });
  context.createVNCPane({ x: 80, y: 0 });
  assert.deepEqual(created.map(({ kind, x, y, width, height }) => [kind, x, y, width, height]), [
    ["browser", 400, 250, 800, 500],
    ["vnc", 400, 250, 800, 500],
    ["browser", 48, 64, 720, 480],
    ["vnc", 80, 24, 720, 480],
  ]);
  assert.match(source, /id: "new-browser"[^\n]*run: \(\) => createBrowserPane\(\) \}/);
  assert.match(source, /id: "new-vnc"[^\n]*run: \(\) => createVNCPane\(\) \}/);
});
