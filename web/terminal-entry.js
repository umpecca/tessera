import {
  CanvasRenderer,
  CellFlags,
  Terminal as GhosttyTerminal,
  init,
} from "ghostty-web";

import { TerminalRenderScheduler } from "./terminal-render-scheduler.mjs";
import { SixelRenderer, installSixelRenderer } from "./terminal-sixel-renderer.mjs";

const renderScheduler = new TerminalRenderScheduler();
installSixelRenderer(CanvasRenderer);
globalThis.addEventListener?.("resize", () => {
  for (const terminal of renderScheduler.entries.keys()) renderScheduler.request(terminal);
});

// Ghostty Web currently owns one permanent animation loop per terminal.
// Adapt that private loop here so the rest of Tessera can use explicit
// visibility and activity state without depending on Ghostty internals.
class Terminal extends GhosttyTerminal {
  constructor(options) {
    super(options);
    this.coreID = __TESSERA_CORE_ID__;
    this.sixelRenderer = new SixelRenderer();
    this.desiredCols = this.cols;
    this.desiredRows = this.rows;
  }

  startRenderLoop() {
    renderScheduler.register(this, () => this.renderScheduledFrame());
  }

  renderScheduledFrame() {
    if (this.isDisposed || !this.isOpen || !this.renderer || !this.wasmTerm) {
      renderScheduler.unregister(this);
      return;
    }
    const pixelRatio = globalThis.devicePixelRatio || 1;
    const resolutionChanged = this.renderer.devicePixelRatio !== pixelRatio;
    if (resolutionChanged) {
      this.renderer.devicePixelRatio = pixelRatio;
      this.renderer.resize(this.cols, this.rows);
    }
    this.renderer.render(
      this.wasmTerm,
      resolutionChanged,
      this.viewportY,
      this,
      this.scrollbarOpacity,
    );
    const cursor = this.wasmTerm.getCursor();
    if (cursor.y !== this.lastCursorY) {
      this.lastCursorY = cursor.y;
      this.cursorMoveEmitter.fire();
    }
  }

  write(data, callback) {
    super.write(data);
    this.sixelRenderer.prune(this.wasmTerm);
    renderScheduler.request(this);
    if (callback) {
      globalThis.requestAnimationFrame(callback);
    }
  }

  reset() {
    this.sixelRenderer.clear();
    super.reset();
  }

  processTerminalResponses() {
    // The host answers queries exactly once, independent of browser count.
    while (this.wasmTerm.readResponse()) {}
    const b = this.wasmTerm, e = b.exports;
    if (!e.tessera_sixel_clipboard_read) return;
    const ptr = e.ghostty_wasm_alloc_u8_array(4096);
    try { while (e.tessera_sixel_clipboard_read(b.handle, ptr, 4096)) {} }
    finally { e.ghostty_wasm_free_u8_array(ptr, 4096); }
  }

  resize(cols, rows) {
    this.desiredCols = cols;
    this.desiredRows = rows;
    this.resizeEmitter.fire({ cols, rows });
  }

  applyGeometry(cols, rows, cellWidth, cellHeight) {
    // Avoid emitting another resize request while applying the host's event.
    this.cols = cols; this.rows = rows;
    this.wasmTerm.resize(cols, rows);
    this.wasmTerm.exports.tessera_sixel_geometry(this.wasmTerm.handle, cellWidth, cellHeight);
    this.renderer.resize(cols, rows);
    this.requestRender();
  }

  applyConfiguration(light) {
    this.wasmTerm.exports.tessera_sixel_configure(this.wasmTerm.handle, light ? 1 : 0);
    this.requestRender();
  }

  imageSettings() {
    const b = this.wasmTerm;
    const value = b.exports.tessera_sixel_image_settings_read(b.handle);
    return { memoryMiB: value & 255, showPlaceholders: Boolean(value & 256) };
  }

  applyImageSettings(memoryMiB, showPlaceholders) {
    const b = this.wasmTerm;
    if (!b.exports.tessera_sixel_image_settings(b.handle, memoryMiB, Number(showPlaceholders))) throw new Error("Invalid image settings");
    this.sixelRenderer.prune(b);
    this.requestRender();
  }

  clearImages() {
    this.wasmTerm.exports.tessera_sixel_clear_images(this.wasmTerm.handle);
    this.sixelRenderer.clear();
    this.requestRender();
  }

  restoreSnapshot(data, geometry) {
    const b = this.wasmTerm, e = b.exports;
    const ptr = e.ghostty_wasm_alloc_u8_array(data.length);
    let handle;
    try {
      new Uint8Array(e.memory.buffer).set(data, ptr);
      handle = e.tessera_sixel_snapshot_import(ptr, data.length);
    } finally { e.ghostty_wasm_free_u8_array(ptr, data.length); }
    if (!handle) throw new Error("Terminal snapshot could not be restored");
    b.free();
    b.handle = handle;
    b._cols = geometry.cols; b._rows = geometry.rows;
    b.initCellPool();
    this.cols = geometry.cols; this.rows = geometry.rows;
    this.viewportY = 0;
    this.sixelRenderer.clear();
    this.clearSelection();
    this.linkDetector?.invalidateCache();
    this.renderer.resize(this.cols, this.rows);
    this.requestRender();
  }

  requestRender() {
    renderScheduler.request(this);
  }

  setRenderContinuous(continuous) {
    renderScheduler.setContinuous(this, continuous);
  }

  setRenderPaused(paused) {
    renderScheduler.setPaused(this, paused);
  }

  dispose() {
    this.sixelRenderer.clear();
    renderScheduler.unregister(this);
    super.dispose();
  }
}

function setTerminalDocumentVisible(visible) {
  renderScheduler.setEnabled(visible);
}

export {
  CanvasRenderer,
  CellFlags,
  Terminal,
  init,
  setTerminalDocumentVisible,
};
export { TesseraFitAddon as FitAddon } from "./terminal-fit-addon.mjs";
export { WrappedHTTPLinkProvider } from "./terminal-links.mjs";
