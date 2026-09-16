import {
  CanvasRenderer,
  CellFlags,
  Terminal as GhosttyTerminal,
  init,
} from "ghostty-web";

import { TerminalRenderScheduler } from "./terminal-render-scheduler.mjs";
import { TerminalCursorBlink } from "./terminal-cursor-blink.mjs";
import { SixelRenderer, installSixelRenderer } from "./terminal-sixel-renderer.mjs";
import { installPlainRenderer } from "./terminal-plain-renderer.mjs";

const renderScheduler = new TerminalRenderScheduler();
installSixelRenderer(CanvasRenderer);
installPlainRenderer(CanvasRenderer);
globalThis.addEventListener?.("resize", () => {
  for (const terminal of renderScheduler.entries.keys()) renderScheduler.request(terminal);
});

// Ghostty Web currently owns one permanent animation loop per terminal.
// Adapt that private loop here so the rest of Tessera can use explicit
// visibility and activity state without depending on Ghostty internals.
class Terminal extends GhosttyTerminal {
  constructor(options = {}) {
    const { renderPixelRatioCap = 0, cursorBlinkEnabled = true, paintFPSLimit = 0, ...terminalOptions } = options;
    super({ ...terminalOptions, cursorBlink: false });
    this.cursorBlink = new TerminalCursorBlink((visible) => {
      if (this.renderer) this.renderer.cursorVisible = visible;
      this.requestRender();
    });
    this.renderPaused = false;
    this.paintFPSLimit = paintFPSLimit;
    this.renderPixelRatioCap = Number.isFinite(renderPixelRatioCap) && renderPixelRatioCap >= 1
      ? renderPixelRatioCap : 0;
    this.cursorBlink.setEnabled(cursorBlinkEnabled !== false);
    // CanvasRenderer.resize() clears the bitmap. Keep this state separate from
    // Ghostty's dirty rows because a same-grid geometry update is a no-op in
    // the terminal core and therefore does not dirty any rows itself.
    this.fullRedrawPending = false;
    this.coreID = __TESSERA_CORE_ID__;
    this.sixelRenderer = new SixelRenderer();
    this.desiredCols = this.cols;
    this.desiredRows = this.rows;
    this.onScroll(() => this.requestRender());
  }

  startRenderLoop() {
    renderScheduler.register(this, () => this.renderScheduledFrame());
  }

  open(container) {
    this.opening = true;
    try {
      super.open(container);
    } finally {
      this.opening = false;
    }
  }

  focus() {
    // Ghostty's open() calls focus(), which also queues a second focus in a
    // timer. Startup must never steal focus from the restored pane or dialog.
    if (!this.opening && this.isOpen && !this.isDisposed) {
      this.element?.focus({ preventScroll: true });
    }
  }

  renderScheduledFrame() {
    if (this.isDisposed || !this.isOpen || !this.renderer || !this.wasmTerm) {
      renderScheduler.unregister(this);
      return;
    }
    const nativePixelRatio = globalThis.devicePixelRatio || 1;
    const pixelRatio = this.renderPixelRatioCap > 0
      ? Math.min(nativePixelRatio, this.renderPixelRatioCap) : nativePixelRatio;
    this.renderer.cursorVisible = this.cursorBlink.cursorVisible;
    // Tessera owns the blink timer, but CanvasRenderer uses this flag to
    // repaint the cursor row on a frame where no terminal cells are dirty.
    // Setting it after construction does not start Ghostty's own timer.
    this.renderer.cursorBlink = true;
    const resolutionChanged = this.renderer.devicePixelRatio !== pixelRatio;
    if (resolutionChanged) {
      this.renderer.devicePixelRatio = pixelRatio;
      this.renderer.resize(this.cols, this.rows);
    }
    const forceFullRedraw = resolutionChanged || this.fullRedrawPending;
    this.renderer.render(
      this.wasmTerm,
      forceFullRedraw,
      this.viewportY,
      this,
      this.scrollbarOpacity,
    );
    this.fullRedrawPending = false;
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
    this.requestRender();
  }

  clear() {
    super.clear();
    this.requestRender();
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
    this.fullRedrawPending = true;
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
    this.fullRedrawPending = true;
    this.requestRender();
  }

  requestRender() {
    renderScheduler.request(this);
  }

  setPaintFPSLimit(limit) {
    this.paintFPSLimit = limit === 30 ? 30 : 0;
  }

  noteInteractiveInput() {
    // Let the next server echo paint promptly, even just after a capped frame.
    this.interactivePaintUntil = performance.now() + 150;
  }

  renderingStatistics() {
    return renderScheduler.statistics(this);
  }

  requestFullRedraw() {
    this.fullRedrawPending = true;
    this.requestRender();
  }

  setRenderPixelRatioCap(cap) {
    const next = Number.isFinite(cap) && cap >= 1 ? cap : 0;
    if (next === this.renderPixelRatioCap) return;
    this.renderPixelRatioCap = next;
    this.requestFullRedraw();
  }

  setCursorBlinkEnabled(enabled) {
    this.cursorBlink.setEnabled(enabled);
  }

  setCursorActive(active) {
    this.cursorBlink.setActive(active);
  }

  setRenderPaused(paused) {
    this.renderPaused = paused;
    renderScheduler.setPaused(this, paused);
    this.cursorBlink.setVisible(!paused && renderScheduler.enabled);
  }

  dispose() {
    this.cursorBlink.dispose();
    this.sixelRenderer.clear();
    renderScheduler.unregister(this);
    super.dispose();
  }
}

function setTerminalDocumentVisible(visible) {
  renderScheduler.setEnabled(visible);
  for (const terminal of renderScheduler.entries.keys()) {
    terminal.cursorBlink.setVisible(visible && !terminal.renderPaused);
  }
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
