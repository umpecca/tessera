import { paneContentFields } from "./pane-content-sync.mjs";

// Serialize workspace state without depending on live DOM or transport state.
// Retired editor documents stay opaque, including when a layout-only save can
// refer to the last acknowledged copy rather than resending large documents.
export function workspaceDocument({ id, revision, name, activePaneID, backgroundMode, panes, defaultPaneFontSize }, savedContent = new Map()) {
  const savedPanes = panes.filter(pane => pane.kind !== "pending");
  const contentByPaneID = new Map(savedPanes.map(pane => [pane.id, {
    bufferText: pane.archivedContent?.bufferText || "",
    editorTabs: pane.archivedContent?.editorTabs || "",
  }]));
  const documents = savedPanes.map((pane, position) => ({
    id: pane.id,
    title: pane.title,
    kind: pane.kind,
    ...paneContentFields(contentByPaneID.get(pane.id), savedContent.get(pane.id)),
    editorMode: pane.archivedContent?.editorMode || "",
    fontSize: pane.kind === "terminal" ? pane.fontSize : defaultPaneFontSize,
    terminalColorMode: pane.kind === "terminal" ? pane.terminalColorMode : "",
    cwd: pane.cwd || "",
    lastExportPath: pane.archivedContent?.lastExportPath || "",
    browserUrl: pane.kind === "browser" ? pane.browserUrl : "",
    vncTarget: pane.kind === "vnc" ? pane.vncTarget : "",
    vncViewOnly: pane.kind === "vnc" && pane.vncViewOnly,
    vncScaleMode: pane.kind === "vnc" ? pane.vncScaleMode : "fit",
    rdpTarget: pane.kind === "rdp" ? pane.rdpTarget : "",
    rdpUsername: pane.kind === "rdp" ? pane.rdpUsername : "",
    rdpDomain: pane.kind === "rdp" ? pane.rdpDomain : "",
    rdpScaleMode: pane.kind === "rdp" ? pane.rdpScaleMode : "fit",
    rdpTrustedTarget: pane.kind === "rdp" ? pane.rdpTrustedTarget : "",
    rdpTrustedFingerprint: pane.kind === "rdp" ? pane.rdpTrustedFingerprint : "",
    rdpFullSize: pane.kind === "rdp" && pane.rdpFullSize,
    rdpWiggle: pane.kind === "rdp" && pane.rdpWiggle,
    rdpWiggleAlways: pane.kind === "rdp" && pane.rdpWiggleAlways,
    rdpResolution: pane.kind === "rdp" ? pane.rdpResolution : "",
    x: pane.x,
    y: pane.y,
    width: pane.width,
    height: pane.height,
    zIndex: pane.zIndex,
    minimized: pane.minimized,
    // Maximization is an attribute, not the size measured on this device.
    isFull: Boolean(pane.isFull),
    restoreBox: pane.restoreBox ? JSON.stringify(pane.restoreBox) : "",
    position,
  }));
  return {
    contentByPaneID,
    body: {
      id,
      revision,
      name: name || "Default",
      activePaneId: savedPanes.some(pane => pane.id === activePaneID) ? activePaneID : "",
      backgroundMode,
      layout: { panes: documents.map(pane => pane.id) },
      panes: documents,
    },
  };
}
