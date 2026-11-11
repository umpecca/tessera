import assert from "node:assert/strict";
import test from "node:test";
import { workspaceDocument } from "./workspace-document.mjs";

function document(panes, options = {}, savedContent) {
  return workspaceDocument({
    id: "workspace", revision: "revision", name: "Work", activePaneID: "terminal",
    backgroundMode: "fill", defaultPaneFontSize: 14, panes, ...options,
  }, savedContent);
}

test("workspace documents preserve geometry, ordering and maximization without DOM state", () => {
  const restoreBox = { x: 10, y: 20, width: 300, height: 200 };
  const panes = [
    { id: "pending", kind: "pending" },
    { id: "terminal", kind: "terminal", title: "Build", fontSize: 18, terminalColorMode: "light",
      cwd: "/work", x: 1, y: 2, width: 800, height: 600, zIndex: 3, minimized: false, isFull: true, restoreBox },
  ];
  // This circular view state must never reach JSON.
  panes[1].element = { pane: panes[1] };
  const { body } = document(panes);
  assert.doesNotThrow(() => JSON.stringify(body));
  assert.equal(body.id, "workspace");
  assert.equal(body.revision, "revision");
  assert.equal(body.name, "Work");
  assert.equal(body.backgroundMode, "fill");
  assert.equal(body.activePaneId, "terminal");
  assert.deepEqual(body.layout, { panes: ["terminal"] });
  const pane = body.panes[0];
  assert.deepEqual([pane.x, pane.y, pane.width, pane.height, pane.zIndex, pane.position], [1, 2, 800, 600, 3, 0]);
  assert.equal(pane.fontSize, 18);
  assert.equal(pane.terminalColorMode, "light");
  assert.equal(pane.isFull, true);
  assert.equal(pane.restoreBox, JSON.stringify(restoreBox));
  assert.equal(pane.element, undefined);
});

test("workspace documents keep archived content and omit only acknowledged fields", () => {
  const archivedContent = { bufferText: "notes", editorTabs: "opaque tabs", editorMode: "code", lastExportPath: "/notes" };
  const panes = [{ id: "terminal", kind: "terminal", archivedContent }];
  const first = document(panes);
  assert.equal(first.body.panes[0].bufferText, "notes");
  assert.equal(first.body.panes[0].editorTabs, "opaque tabs");
  assert.equal(first.body.panes[0].editorMode, "code");
  assert.equal(first.body.panes[0].lastExportPath, "/notes");
  const next = document(panes, {}, first.contentByPaneID);
  assert.equal(next.body.panes[0].bufferTextUnchanged, true);
  assert.equal(next.body.panes[0].editorTabsUnchanged, true);
  archivedContent.bufferText = "new notes";
  const changed = document(panes, {}, first.contentByPaneID);
  assert.equal(changed.body.panes[0].bufferText, "new notes");
  assert.equal(changed.body.panes[0].editorTabsUnchanged, true);
  assert.equal(first.contentByPaneID.get("terminal").bufferText, "notes", "a live edit must not mutate the ACK snapshot");
});

test("pane-specific settings survive serialization but credentials and views do not", () => {
  const browser = { id: "browser", kind: "browser", browserUrl: "http://localhost:3000" };
  const vnc = { id: "vnc", kind: "vnc", vncTarget: "localhost:5900", vncViewOnly: true, vncScaleMode: "one-to-one" };
  const rdp = {
    id: "rdp", kind: "rdp", rdpTarget: "localhost:3389", rdpUsername: "alice", rdpDomain: "domain",
    rdpScaleMode: "resize-2x", rdpTrustedTarget: "localhost:3389", rdpTrustedFingerprint: "fingerprint",
    rdpFullSize: true, rdpWiggle: true, rdpWiggleAlways: false, rdpResolution: "1920x1080",
    password: "secret", rdp: { password: "secret" },
  };
  const { body } = document([browser, vnc, rdp]);
  assert.equal(body.panes[0].browserUrl, browser.browserUrl);
  assert.equal(body.panes[1].vncTarget, vnc.vncTarget);
  assert.equal(body.panes[1].vncViewOnly, true);
  assert.equal(body.panes[1].vncScaleMode, "one-to-one");
  for (const [key, value] of Object.entries(rdp).filter(([key]) => key.startsWith("rdp") && key !== "rdp")) {
    assert.equal(body.panes[2][key], value, key);
  }
  assert.ok(body.panes.every(pane => pane.fontSize === 14));
  assert.equal(body.panes[0].rdpTarget, "");
  assert.equal(body.panes[2].vncTarget, "");
  assert.ok(!JSON.stringify(body).includes("secret"));
});

test("missing workspace names and active panes retain the wire-format defaults", () => {
  const { body } = document([{ id: "pending", kind: "pending" }], { name: "", activePaneID: "pending" });
  assert.equal(body.name, "Default");
  assert.equal(body.activePaneId, "");
  assert.deepEqual(body.layout, { panes: [] });
  assert.deepEqual(body.panes, []);
});
