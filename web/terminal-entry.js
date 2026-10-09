import {
  CanvasRenderer,
  CellFlags,
  Terminal as GhosttyTerminal,
  init,
} from "ghostty-web";

import { TerminalRenderScheduler } from "./terminal-render-scheduler.mjs";
import { TerminalCursorBlink } from "./terminal-cursor-blink.mjs";
import { installTerminalSelection } from "./terminal-selection.mjs";
import { installTerminalFontMetrics } from "./terminal-font-metrics.mjs";
import { defaultTerminalRowSpacing, normalizeTerminalRowSpacing } from "./terminal-settings.mjs";
import { SixelRenderer, installSixelRenderer } from "./terminal-sixel-renderer.mjs";
import { installTerminalViewportReader } from "./terminal-viewport.mjs";
import { TerminalInputBuffer } from "./terminal-input-buffer.mjs";
import { installTerminalPixelGrid } from "./terminal-pixel-grid.mjs";
import {
  installPlainRenderer,
  plainRendererStatistics,
  setPlainRendererEnabled,
} from "./terminal-plain-renderer.mjs";

const renderScheduler = new TerminalRenderScheduler();
installTerminalFontMetrics(CanvasRenderer);
installSixelRenderer(CanvasRenderer);
installTerminalPixelGrid(CanvasRenderer);
installTerminalViewportReader(CanvasRenderer);
installPlainRenderer(CanvasRenderer);
globalThis.addEventListener?.("resize", () => {
  for (const terminal of renderScheduler.entries.keys()) renderScheduler.request(terminal);
});

// Ghostty Web currently owns one permanent animation loop per terminal.
// Adapt that private loop here so the rest of Tessera can use explicit
// visibility and activity state without depending on Ghostty internals.
class Terminal extends GhosttyTerminal {
  constructor(options = {}) {
    const {
      renderPixelRatioCap = 0,
      cursorBlinkEnabled = true,
      experimentalRenderer = false,
      paintFPSLimit = 0,
      paintCoalescing = false,
      renderMetricsEnabled = false,
      symbolFontFamily = "",
      rowSpacing = defaultTerminalRowSpacing,
      ...terminalOptions
    } = options;
    super({ ...terminalOptions, cursorBlink: false });
    this.cursorRedrawPending = false;
    this.cursorBlink = new TerminalCursorBlink((visible) => {
      if (this.renderer) this.renderer.cursorVisible = visible;
      this.cursorRedrawPending = true;
      this.requestRender();
    });
    this.renderPaused = false;
    this.experimentalRenderer = experimentalRenderer === true;
    this.paintFPSLimit = paintFPSLimit;
    this.paintCoalescing = paintCoalescing === true;
    this.renderMetricsEnabled = renderMetricsEnabled === true;
    this.symbolFontFamily = symbolFontFamily;
    this.rowSpacing = normalizeTerminalRowSpacing(rowSpacing);
    this.renderPixelRatioCap = Number.isFinite(renderPixelRatioCap) && renderPixelRatioCap >= 1
      ? renderPixelRatioCap : 0;
    this.cursorBlink.setEnabled(cursorBlinkEnabled !== false);
    // CanvasRenderer.resize() clears the bitmap. Keep this state separate from
    // Ghostty's dirty rows because a same-grid geometry update is a no-op in
    // the terminal core and therefore does not dirty any rows itself.
    this.fullRedrawPending = false;
    this.coreID = __TESSERA_CORE_ID__;
    this.sixelRenderer = new SixelRenderer();
    this.clipboardReadBuffer = null;
    this.audioReadBuffer = null;
    this.inputBuffer = new TerminalInputBuffer();
    this.desiredCols = this.cols;
    this.desiredRows = this.rows;
    this.onScroll(() => this.requestRender());
  }

  startRenderLoop() {
    renderScheduler.register(this, () => this.renderScheduledFrame());
    renderScheduler.setActive(this, this.cursorBlink.active && !this.renderPaused);
    renderScheduler.setMetricsEnabled(this, this.renderMetricsEnabled);
  }

  open(container) {
    this.opening = true;
    try {
      super.open(container);
      this.inputBuffer.attach(this.wasmTerm);
      if (this.renderer) {
        this.renderer.tesseraSymbolFontFamily = this.symbolFontFamily;
        this.renderer.tesseraRowSpacing = this.rowSpacing;
        if (this.rowSpacing !== defaultTerminalRowSpacing) this.setRowSpacing(this.rowSpacing);
      }
      setPlainRendererEnabled(this.renderer, this.experimentalRenderer);
      this.selectionIntegration = installTerminalSelection(this);
      const canvas = this.renderer?.canvas;
      if (canvas) {
        const lost = () => {
          this.canvasContextLost = true;
          this.fullRedrawPending = true;
          // Cancelling a 2D contextlost event prevents automatic restoration.
        };
        const restored = () => {
          if (this.isDisposed) return;
          this.canvasContextLost = false;
          this.sixelRenderer.clear();
          // A restored context has a blank bitmap and default drawing state.
          // Restore the DPR transform and invalidate pixels, not native history.
          this.renderer.resize(this.cols, this.rows);
          this.requestFullRedraw();
        };
        canvas.addEventListener("contextlost", lost);
        canvas.addEventListener("contextrestored", restored);
        this.canvasContextRecovery = { canvas, lost, restored };
      }
    } finally {
      this.opening = false;
    }
  }

  focus() {
    // Ghostty's open() calls focus(), which also queues a second focus in a
    // timer. Startup must never steal focus from the restored pane or dialog.
    if (!this.opening && this.isOpen && !this.isDisposed) {
      this.element?.focus({ preventScroll: true });
      this.selectionIntegration?.clearNativeSelection();
    }
  }

  renderScheduledFrame() {
    if (this.isDisposed || !this.isOpen || !this.renderer || !this.wasmTerm) {
      renderScheduler.unregister(this);
      return;
    }
    if (this.canvasContextLost || this.renderer.ctx?.isContextLost?.()) {
      this.fullRedrawPending = true;
      return;
    }
    const nativePixelRatio = globalThis.devicePixelRatio || 1;
    const pixelRatio = this.renderPixelRatioCap > 0
      ? Math.min(nativePixelRatio, this.renderPixelRatioCap) : nativePixelRatio;
    this.renderer.cursorVisible = this.cursorBlink.cursorVisible;
    // Tessera owns the blink timer. Invalidate the cursor row only on the
    // frame requested by that timer, not on unrelated output frames.
    this.renderer.cursorBlink = this.cursorRedrawPending;
    const resolutionChanged = this.renderer.devicePixelRatio !== pixelRatio;
    if (resolutionChanged) {
      this.renderer.devicePixelRatio = pixelRatio;
      this.renderer.resize(this.cols, this.rows);
    }
    const forceFullRedraw = resolutionChanged || this.fullRedrawPending;
    try {
      this.renderer.render(
        this.wasmTerm,
        forceFullRedraw,
        this.viewportY,
        this,
        this.scrollbarOpacity,
      );
    } finally {
      this.renderer.cursorBlink = false;
      this.cursorRedrawPending = false;
    }
    if (this.canvasContextLost || this.renderer.ctx?.isContextLost?.()) {
      this.fullRedrawPending = true;
      return;
    }
    this.fullRedrawPending = false;
    this.outputTiming?.painted();
    const cursor = this.wasmTerm.getCursor();
    if (cursor.y !== this.lastCursorY) {
      this.lastCursorY = cursor.y;
      this.cursorMoveEmitter.fire();
    }
  }

  write(data, callback) {
    super.write(data);
    this.sixelRenderer.prune(this.wasmTerm);
    renderScheduler.noteOutput(this);
    if (callback) {
      globalThis.requestAnimationFrame(callback);
    }
  }

  reset() {
    this.sixelRenderer.clear();
    super.reset();
    this.inputBuffer.attach(this.wasmTerm);
    this.requestRender();
  }

  clear() {
    super.clear();
    this.requestRender();
  }

  processTerminalResponses() {
    const audioCore = this.wasmTerm;
    const audioExports = audioCore.exports;
    if (audioExports.tessera_audio_read) {
      this.audioReadBuffer ??= { exports: audioExports, ptr: audioExports.ghostty_wasm_alloc_u8_array(4096) };
      while (audioExports.tessera_audio_read(audioCore.handle, this.audioReadBuffer.ptr, 4096)) {}
      while (audioExports.tessera_file_read?.(audioCore.handle, this.audioReadBuffer.ptr, 4096)) {}
    }
    // The host answers queries exactly once, independent of browser count.
    while (this.wasmTerm.readResponse()) {}
    const b = this.wasmTerm, e = b.exports;
    if (!e.tessera_sixel_clipboard_read) return;
    // The allocation belongs to the module, so it survives reset and snapshot
    // handle replacement. Keep only its pointer; WASM memory can grow.
    this.clipboardReadBuffer ??= { exports: e, ptr: e.ghostty_wasm_alloc_u8_array(4096) };
    while (e.tessera_sixel_clipboard_read(b.handle, this.clipboardReadBuffer.ptr, 4096)) {}
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

  setPaintCoalescing(enabled) {
    this.paintCoalescing = enabled === true;
    this.requestRender();
  }

  setExperimentalRenderer(enabled) {
    this.experimentalRenderer = enabled === true;
    if (this.renderer) {
      setPlainRendererEnabled(this.renderer, this.experimentalRenderer);
      this.requestFullRedraw();
    }
  }

  setFontFamilies(fontFamily, symbolFontFamily) {
    this.symbolFontFamily = symbolFontFamily;
    this.options.fontFamily = fontFamily;
    if (this.renderer) {
      this.renderer.tesseraSymbolFontFamily = symbolFontFamily;
      this.requestFullRedraw();
    }
  }

  setRowSpacing(value) {
    this.rowSpacing = normalizeTerminalRowSpacing(value);
    if (this.renderer) {
      this.renderer.tesseraRowSpacing = this.rowSpacing;
      this.renderer.remeasureFont();
      this.renderer.resize(this.cols, this.rows);
      this.requestFullRedraw();
    }
  }

  noteInteractiveInput() {
    // Let the next server echo paint promptly, even just after a capped frame.
    this.interactivePaintUntil = performance.now() + 150;
  }

  renderingStatistics() {
    return {
      ...renderScheduler.statistics(this),
      rendererRows: plainRendererStatistics(this.renderer),
    };
  }

  setRenderingMetricsEnabled(enabled) {
    this.renderMetricsEnabled = enabled === true;
    renderScheduler.setMetricsEnabled(this, this.renderMetricsEnabled);
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
    renderScheduler.setActive(this, active);
    this.cursorBlink.setActive(active);
  }

  setRenderPaused(paused) {
    this.renderPaused = paused;
    renderScheduler.setPaused(this, paused);
    this.cursorBlink.setVisible(!paused && renderScheduler.enabled);
  }

  dispose() {
    if (this.audioReadBuffer) {
      const { exports, ptr } = this.audioReadBuffer;
      this.audioReadBuffer = null;
      exports.ghostty_wasm_free_u8_array(ptr, 4096);
    }
    if (this.canvasContextRecovery) {
      const { canvas, lost, restored } = this.canvasContextRecovery;
      canvas.removeEventListener("contextlost", lost);
      canvas.removeEventListener("contextrestored", restored);
      this.canvasContextRecovery = null;
    }
    this.selectionIntegration?.dispose();
    this.cursorBlink.dispose();
    this.sixelRenderer.clear();
    renderScheduler.unregister(this);
    this.inputBuffer.dispose();
    if (this.clipboardReadBuffer) {
      const { exports, ptr } = this.clipboardReadBuffer;
      this.clipboardReadBuffer = null;
      exports.ghostty_wasm_free_u8_array(ptr, 4096);
    }
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
