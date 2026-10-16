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
import { TerminalScroll, installTerminalScrollRenderer, terminalScrollMouseEvent } from "./terminal-scroll.mjs";
import { TerminalPrediction } from "./terminal-prediction.mjs";
import { TerminalPredictionOverlay } from "./terminal-prediction-overlay.mjs";
import {
  installPlainRenderer,
  plainRendererStatistics,
  setPlainRendererEnabled,
} from "./terminal-plain-renderer.mjs";

const renderScheduler = new TerminalRenderScheduler();
installTerminalFontMetrics(CanvasRenderer);
installSixelRenderer(CanvasRenderer);
installTerminalScrollRenderer(CanvasRenderer);
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
      predictionMode = "auto",
      ...terminalOptions
    } = options;
    super({ smoothScrollDuration: 120, ...terminalOptions, cursorBlink: false });
    this.smoothScroll = new TerminalScroll(this);
    const handleClick = this.handleClick;
    this.handleClick = event => handleClick(terminalScrollMouseEvent(this, event));
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
    this.titleRevision = null;
    this.audioReadBuffer = null;
    this.inputBuffer = new TerminalInputBuffer();
    this.desiredCols = this.cols;
    this.desiredRows = this.rows;
    this.onScroll(() => { if (!this.advancingScroll) this.requestRender(); });
    this.prediction = new TerminalPrediction({ mode: predictionMode });
    this.predictionOverlay = null;
    this.predictionOverlayDirty = false;
    this.predictionTimer = null;
    this.predictionAlternateScreen = false;
  }

  // predictInput sees keyboard input before it is sent. A printable
  // character may be drawn at once; anything else ends the prediction run.
  predictInput(data) {
    if (!this.wasmTerm || !this.renderer || this.renderPaused) {
      this.resetPredictions();
      return;
    }
    if (this.prediction.input(data, this.predictionScreen())) {
      // Nothing on the terminal canvas changes yet, so draw immediately.
      this.predictionOverlay ??= new TerminalPredictionOverlay(this.renderer);
      this.predictionOverlay.draw(this.prediction.visible());
    } else if (!this.prediction.predictions.length) {
      this.markPredictionsChanged();
    }
    this.schedulePredictionCheck();
  }

  // predictionScreen exposes the cursor and cells the engine may compare.
  predictionScreen() {
    const core = this.wasmTerm;
    const cursor = core.getCursor();
    const alternate = core.isAlternateScreen?.() ?? false;
    if (!this.prediction.predictions.length) this.predictionAlternateScreen = alternate;
    const atBottom = this.viewportY === 0 && !((this.smoothScroll.target ?? 0) > 0);
    const lines = new Map();
    return {
      cols: this.cols,
      cursorX: cursor.x,
      cursorY: cursor.y,
      canPredict: atBottom && cursor.visible !== false && alternate === this.predictionAlternateScreen,
      cellAt: (col, row) => {
        if (!lines.has(row)) lines.set(row, core.getLine(row));
        return lines.get(row)?.[col]?.codepoint ?? 0;
      },
    };
  }

  checkPredictions() {
    if (!this.prediction.predictions.length || !this.wasmTerm) return;
    if (this.prediction.check(this.predictionScreen())) this.markPredictionsChanged();
    this.schedulePredictionCheck();
  }

  // A confirmed prediction is erased in the same paint that draws the real
  // character, so the text never blinks out between the two.
  markPredictionsChanged() {
    this.predictionOverlayDirty = true;
    this.requestRender();
  }

  schedulePredictionCheck() {
    globalThis.clearTimeout(this.predictionTimer);
    this.predictionTimer = null;
    const deadline = this.prediction.nextDeadline();
    if (deadline === null) return;
    this.predictionTimer = globalThis.setTimeout(() => {
      this.predictionTimer = null;
      this.checkPredictions();
    }, Math.max(0, deadline - this.prediction.now()) + 1);
  }

  resetPredictions() {
    globalThis.clearTimeout(this.predictionTimer);
    this.predictionTimer = null;
    if (this.prediction.reset()) this.markPredictionsChanged();
  }

  setPredictionMode(mode) {
    if (this.prediction.setMode(mode)) this.markPredictionsChanged();
  }

  predictionStatistics() {
    const { mode, srtt, showing } = this.prediction;
    return { mode, latencyMs: srtt === null ? null : Math.round(srtt), showing };
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
    this.advancingScroll = true;
    let scrolling;
    try { scrolling = this.smoothScroll.advance(); }
    finally { this.advancingScroll = false; }
    const fadingScrollbar = this.advanceScrollbar();
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
    if (this.predictionOverlayDirty || (forceFullRedraw && this.predictionOverlay?.drawn)) {
      this.predictionOverlayDirty = false;
      this.predictionOverlay ??= new TerminalPredictionOverlay(this.renderer);
      this.predictionOverlay.draw(this.prediction.visible());
    }
    if (scrolling || fadingScrollbar) this.requestRender();
    this.outputTiming?.painted();
    const cursor = this.wasmTerm.getCursor();
    if (cursor.y !== this.lastCursorY) {
      this.lastCursorY = cursor.y;
      this.cursorMoveEmitter.fire();
    }
  }

  write(data, callback) {
    const readingHistory = this.viewportY > 0 || (this.smoothScroll.target ?? 0) > 0;
    const historyBefore = readingHistory ? this.getScrollbackLength() : 0;
    // Ghostty follows every write, which fights wheel gestures and makes it
    // impossible to read history while a command continues producing output.
    this.writingWhileScrolled = readingHistory;
    try { super.write(data); }
    finally { this.writingWhileScrolled = false; }
    this.syncWindowTitle();
    if (readingHistory) {
      if (this.wasmTerm.isAlternateScreen?.()) this.scrollToBottom();
      else {
        const historyAfter = this.getScrollbackLength();
        const added = Math.max(0, historyAfter - historyBefore);
        this.viewportY = Math.min(historyAfter, this.viewportY + added);
        if (this.smoothScroll.target !== null) {
          this.smoothScroll.target = Math.min(historyAfter,
            this.smoothScroll.target > 0 ? this.smoothScroll.target + added : 0);
        }
        this.targetViewportY = this.smoothScroll.target ?? this.viewportY;
      }
    }
    this.sixelRenderer.prune(this.wasmTerm);
    this.checkPredictions();
    renderScheduler.noteOutput(this);
    if (callback) {
      globalThis.requestAnimationFrame(callback);
    }
  }

  reset() {
    this.resetPredictions();
    this.smoothScroll.cancel();
    this.sixelRenderer.clear();
    super.reset();
    this.inputBuffer.attach(this.wasmTerm);
    this.titleRevision = null;
    this.requestRender();
  }

  clear() {
    this.smoothScroll.cancel();
    super.clear();
    this.requestRender();
  }

  // The library's regex only sees complete string writes. Read the shared
  // parser instead so byte writes, split OSC sequences, and snapshots agree.
  checkForTitleChange() {}

  syncWindowTitle() {
    const b = this.wasmTerm, e = b?.exports;
    if (!e?.tessera_sixel_title_revision) return;
    const revision = e.tessera_sixel_title_revision(b.handle);
    if (revision === this.titleRevision) return;
    this.titleRevision = revision;
    const length = e.tessera_sixel_title_length(b.handle);
    if (!length) return;
    this.currentTitle = new TextDecoder().decode(new Uint8Array(e.memory.buffer,
      e.tessera_sixel_title_data(b.handle), length));
    this.titleChangeEmitter.fire(this.currentTitle);
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
    this.resetPredictions();
    this.smoothScroll.cancel();
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
    this.resetPredictions();
    this.smoothScroll.cancel();
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
    this.titleRevision = null;
    this.syncWindowTitle();
    b._cols = geometry.cols; b._rows = geometry.rows;
    b.initCellPool();
    this.cols = geometry.cols; this.rows = geometry.rows;
    this.viewportY = 0;
    this.targetViewportY = 0;
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

  scrollWheelLines(lines) {
    this.resetPredictions();
    this.smoothScroll.by(lines);
  }

  smoothScrollTo(position) {
    if (position > 0) this.resetPredictions();
    this.smoothScroll.to(position);
  }

  scrollLines(lines) {
    this.resetPredictions();
    this.smoothScroll.cancel();
    super.scrollLines(lines);
    this.targetViewportY = this.viewportY;
  }

  scrollToLine(line) {
    this.resetPredictions();
    this.smoothScroll.cancel();
    super.scrollToLine(line);
    this.targetViewportY = this.viewportY;
  }

  scrollToTop() {
    this.resetPredictions();
    this.smoothScroll.cancel();
    super.scrollToTop();
    this.targetViewportY = this.viewportY;
  }

  scrollToBottom() {
    if (this.writingWhileScrolled) return;
    this.smoothScroll.cancel();
    super.scrollToBottom();
    this.targetViewportY = this.viewportY;
  }

  processMouseMove(event) {
    super.processMouseMove(terminalScrollMouseEvent(this, event));
  }

  fadeInScrollbar() {
    this.scrollbarFade = { from: this.scrollbarOpacity, to: 1, started: performance.now() };
    this.requestRender();
  }

  showScrollbar() {
    const visible = this.scrollbarVisible;
    super.showScrollbar();
    if (visible) this.scrollbarFade = null;
  }

  fadeOutScrollbar() {
    this.scrollbarFade = { from: this.scrollbarOpacity, to: 0, started: performance.now() };
    this.requestRender();
  }

  advanceScrollbar() {
    const fade = this.scrollbarFade;
    if (!fade) return false;
    const progress = Math.min(1, (performance.now() - fade.started) / this.SCROLLBAR_FADE_DURATION_MS);
    this.scrollbarOpacity = fade.from + (fade.to - fade.from) * progress;
    if (progress === 1) {
      this.scrollbarVisible = fade.to > 0;
      this.scrollbarFade = null;
    }
    return progress < 1;
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
    if (paused) {
      this.smoothScroll.cancel();
      this.resetPredictions();
    }
    this.renderPaused = paused;
    renderScheduler.setPaused(this, paused);
    this.cursorBlink.setVisible(!paused && renderScheduler.enabled);
  }

  dispose() {
    globalThis.clearTimeout(this.predictionTimer);
    this.predictionOverlay?.dispose();
    this.smoothScroll.cancel();
    this.scrollbarFade = null;
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
    if (!visible) terminal.smoothScroll.cancel();
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
