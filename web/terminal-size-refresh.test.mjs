import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { TerminalFitScheduler } from "./terminal-fit-scheduler.mjs";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
function appFunction(name, context) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}\n", start) + 2;
  return vm.runInNewContext(`(${source.slice(start, end)})`, context);
}

test("Refresh Terminal Size refits every terminal on screen and reclaims each shell's size", () => {
  const frames = [];
  const sent = [];
  const fits = [];
  const terminal = (id, { minimized = false, measured }) => {
    const term = { cols: 80, rows: 50, desiredCols: 80, desiredRows: 50, renderer: { getMetrics: () => ({ width: 9, height: 18 }) } };
    const state = {
      term, sentCols: 120, sentRows: 40,
      socket: { readyState: 1, send: (message) => sent.push([id, JSON.parse(message)]) },
      fit: { lastColumns: measured.cols, lastRows: measured.rows, fit() { fits.push(id); term.desiredCols = measured.cols; term.desiredRows = measured.rows; } },
    };
    return { id, kind: "terminal", minimized, terminal: state };
  };
  const visible = terminal("visible", { measured: { cols: 120, rows: 40 } });
  const minimized = terminal("minimized", { minimized: true, measured: { cols: 100, rows: 30 } });
  const scheduler = new TerminalFitScheduler({ requestFrame: (callback) => frames.push(callback), setTimer: () => 1, clearTimer() {} });
  let status;
  appFunction("refreshTerminalSizes", {
    rectangles: [visible, { kind: "browser" }, minimized], terminalFits: scheduler,
    requestTerminalFit: (rect) => scheduler.request(rect.terminal),
    window: { requestAnimationFrame: (callback) => frames.push(callback) },
    setWorkspaceStatus: (_state, text) => { status = text; },
  })();
  assert.equal(visible.terminal.fit.lastColumns, undefined, "cached fit decisions are discarded");
  for (const frame of frames.splice(0)) frame();
  assert.deepEqual(fits, ["visible"], "minimized panes are left alone");
  assert.deepEqual(sent, [["visible", { type: "resize", cols: 120, rows: 40, cellWidth: 9, cellHeight: 18 }]],
    "the size is sent at once even though this browser sent the same grid before");
  assert.equal(status, "Terminal size refreshed");
});

test("the palette offers Refresh Terminal Size only while a terminal is on screen", () => {
  const globals = (rectangles) => ({
    browseLocalPortHelpCommand: { id: "browse-local-port-help", label: "Browse local port" },
    deskbarButtonEnabled: true, currentSessionName: "Main", currentSessionID: "main", sessions: [],
    rectangles, getActivePane: () => null, arrangeOutSnapshot: null, workspaceMenuLabel: (pane) => pane.title,
    window: {}, multiUser: false, openShortcuts() {}, shortcutsUI: { items: [] },
  });
  const ids = (rectangles) => appFunction("buildPaletteCommands", globals(rectangles))().map((command) => command.id);
  const live = { kind: "terminal", title: "Terminal", minimized: false, terminal: { term: {} } };
  assert.ok(ids([live]).includes("refresh-terminal-size"));
  assert.ok(!ids([{ ...live, minimized: true }]).includes("refresh-terminal-size"));
  assert.ok(!ids([]).includes("refresh-terminal-size"));
});
