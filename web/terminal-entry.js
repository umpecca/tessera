import {
  CanvasRenderer,
  CellFlags,
  OSC8LinkProvider,
  Terminal as GhosttyTerminal,
  UrlRegexProvider,
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
import { TerminalLinkHover } from "./terminal-link-hover.mjs";
import { defaultTerminalPointerShape, terminalPointerShape } from "./terminal-pointer-shape.mjs";
import { adjacentPrompt, commandOutput, lastCommandOutput, promptStarts } from "./terminal-prompts.mjs";
import { terminalThemeWithProgramColors } from "./terminal-colors.mjs";
import { HyperlinkProvider, RoutedLinkProvider, replaceLinkProvider } from "./terminal-links.mjs";
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
      openLink = url => globalThis.open(url, "_blank", "noopener,noreferrer"),
      ...terminalOptions
    } = options;
    super({ smoothScrollDuration: 120, ...terminalOptions, cursorBlink: false });
    this.smoothScroll = new TerminalScroll(this);
    const handleClick = this.handleClick;
    this.handleClick = event => handleClick(terminalScrollMouseEvent(this, event));
    this.linkHover = new TerminalLinkHover(this);
    this.openLink = openLink;
    const handleMouseLeave = this.handleMouseLeave;
    this.handleMouseLeave = (event) => {
      this.linkHover.leave();
      handleMouseLeave(event);
      this.applyPointerShape();
    };
    this.cursorRedrawPending = false;
    this.cursorBlink = new TerminalCursorBlink((visible) => {
      if (this.renderer) this.renderer.cursorVisible = visible;
      this.cursorRedrawPending = true;
      // A predicted cursor blinks with the real one.
      if (this.predictionOverlay?.drawn) this.predictionOverlayDirty = true;
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
    this.hyperlinkReadBuffer = null;
    this.titleRevision = null;
    this.workingDirectoryRevision = null;
    this.workingDirectoryReport = "";
    this.workingDirectoryEmitter = new Set();
    this.pointerShape = defaultTerminalPointerShape;
    this.colorRevision = null;
    this.baseTheme = null;
    this.audioReadBuffer = null;
    this.inputBuffer = new TerminalInputBuffer();
    this.desiredCols = this.cols;
    this.desiredRows = this.rows;
    this.onScroll(() => {
      this.linkHover.recheck();
      if (!this.advancingScroll) this.requestRender();
    });
    this.prediction = new TerminalPrediction({ mode: predictionMode });
    this.predictionOverlay = null;
    this.predictionOverlayDirty = false;
    this.predictionTimer = null;
    this.predictionAlternateScreen = false;
  }

  // predictInput sees keyboard input before it is sent. A printable
  // character may be drawn at once; anything else ends the prediction run.
  predictInput(data) {
    this.cursorBlink.wake();
    if (!this.wasmTerm || !this.renderer || this.renderPaused) {
      this.resetPredictions();
      return;
    }
    if (this.prediction.input(data, this.predictionScreen())) {
      // Nothing on the terminal canvas changes yet, so draw immediately.
      this.drawPredictions();
    } else if (!this.prediction.predictions.length) {
      this.markPredictionsChanged();
    }
    this.schedulePredictionCheck();
  }

  drawPredictions() {
    this.predictionOverlay ??= new TerminalPredictionOverlay(this.renderer);
    const visible = this.prediction.visible();
    if (!this.cursorBlink.cursorVisible) visible.cursor = null;
    this.predictionOverlay.draw(visible);
  }

  // predictionScreen exposes the cursor and cells the engine may compare.
  predictionScreen() {
    const core = this.wasmTerm;
    const cursor = core.getCursor();
    const alternate = core.isAlternateScreen?.() ?? false;
    if (!this.prediction.predictions.length) this.predictionAlternateScreen = alternate;
    const atBottom = this.viewportY === 0 && !((this.smoothScroll.target ?? 0) > 0);
    return {
      cols: this.cols,
      cursorX: cursor.x,
      cursorY: cursor.y,
      canPredict: atBottom && cursor.visible !== false && alternate === this.predictionAlternateScreen,
      // One cell from the render state getCursor just refreshed. getLine
      // would copy and parse the whole viewport, which cost a few
      // milliseconds per keystroke on an iPad.
      cellAt: (col, row) => {
        if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return 0;
        return core.getGrapheme(row, col)?.[0] ?? 0;
      },
    };
  }

  // checkPredictions runs after each write, and at a deadline (output false).
  checkPredictions(output = true) {
    if (!this.prediction.predictions.length || !this.wasmTerm) return;
    if (this.prediction.check(this.predictionScreen(), { output })) this.markPredictionsChanged();
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
      this.checkPredictions(false);
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

  // noteInputSent runs once keyboard input has been handed to the socket.
  noteInputSent() {
    this.prediction.noteSent();
  }

  // noteOutputArrival runs as the socket handler for server output starts.
  noteOutputArrival() {
    if (this.prediction.predictions.length) this.prediction.noteArrival();
  }

  predictionStatistics() {
    const { mode, srtt, showing } = this.prediction;
    return {
      mode, latencyMs: srtt === null ? null : Math.round(srtt), showing,
      underlined: this.prediction.underlined(), breakdown: this.prediction.latencyBreakdown(),
    };
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
        // Ghostty's own loop drew a hovered link's underline on its next
        // frame; the render scheduler paints only when asked. ghostty-web
        // sets the pointer just before the link range, so put back the
        // program's pointer shape there too.
        for (const name of ["setHoveredHyperlinkId", "setHoveredLinkRange"]) {
          const set = this.renderer[name];
          if (typeof set === "function") {
            this.renderer[name] = (value) => {
              set.call(this.renderer, value);
              if (name === "setHoveredLinkRange") this.applyPointerShape();
              this.requestRender();
            };
          }
        }
        this.renderer.tesseraSymbolFontFamily = this.symbolFontFamily;
        this.renderer.tesseraRowSpacing = this.rowSpacing;
        if (this.rowSpacing !== defaultTerminalRowSpacing) this.setRowSpacing(this.rowSpacing);
      }
      setPlainRendererEnabled(this.renderer, this.experimentalRenderer);
      this.selectionIntegration = installTerminalSelection(this);
      replaceLinkProvider(this.linkDetector, provider => provider instanceof OSC8LinkProvider,
        () => new HyperlinkProvider(this, { onHover: uri => this.linkHover.set(uri), openURL: url => this.openLink(url) }));
      replaceLinkProvider(this.linkDetector, provider => provider instanceof UrlRegexProvider,
        provider => new RoutedLinkProvider(provider, url => this.openLink(url)));
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
      this.drawPredictions();
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
    this.syncWorkingDirectory();
    this.syncPointerShape();
    this.syncColors();
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
    this.linkHover.recheck();
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
    this.workingDirectoryRevision = null;
    this.syncPointerShape();
    this.colorRevision = null;
    this.syncColors();
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
    if (!length) {
      // A program's title went away (a pop to none, or a reset). Say so once.
      if (this.currentTitle) {
        this.currentTitle = "";
        this.titleChangeEmitter.fire("");
      }
      return;
    }
    this.currentTitle = new TextDecoder().decode(new Uint8Array(e.memory.buffer,
      e.tessera_sixel_title_data(b.handle), length));
    this.titleChangeEmitter.fire(this.currentTitle);
  }

  // OSC 7: the shell's working directory, as the file:// URL it reported.
  syncWorkingDirectory() {
    const b = this.wasmTerm, e = b?.exports;
    if (!e?.tessera_pwd_revision) return;
    const revision = e.tessera_pwd_revision(b.handle);
    if (revision === this.workingDirectoryRevision) return;
    this.workingDirectoryRevision = revision;
    const length = e.tessera_pwd_length(b.handle);
    if (!length) return;
    this.workingDirectoryReport = new TextDecoder().decode(new Uint8Array(e.memory.buffer,
      e.tessera_pwd_data(b.handle), length));
    for (const listener of this.workingDirectoryEmitter) listener(this.workingDirectoryReport);
  }

  onWorkingDirectoryChange(listener) {
    this.workingDirectoryEmitter.add(listener);
    return { dispose: () => this.workingDirectoryEmitter.delete(listener) };
  }

  // OSC 4 and 10-19. The core draws text and cell backgrounds in a
  // program's palette and colours itself; the renderer's theme supplies the
  // rest (the canvas and padding background, cursor, selection), so lay the
  // program's colours over the pane's own there.
  syncColors() {
    const b = this.wasmTerm, e = b?.exports;
    const theme = this.renderer?.theme;
    if (!e?.tessera_color_revision || !theme) return;
    const revision = e.tessera_color_revision(b.handle);
    if (revision === this.colorRevision) return;
    this.colorRevision = revision;
    this.baseTheme ??= { ...theme };
    const ptr = e.ghostty_wasm_alloc_u8_array(20);
    let values;
    try {
      e.tessera_dynamic_colors(b.handle, ptr);
      // A byte allocation need not be 4-byte aligned for a Uint32Array.
      const view = new DataView(e.memory.buffer, ptr, 20);
      values = [0, 1, 2, 3, 4].map((index) => view.getUint32(index * 4, true));
    } finally { e.ghostty_wasm_free_u8_array(ptr, 20); }
    Object.assign(theme, terminalThemeWithProgramColors(this.baseTheme, values));
    if (this.element?.style) this.element.style.background = theme.background;
    this.fullRedrawPending = true;
    this.requestRender();
  }

  // OSC 22: the pointer shape a program asked for over the terminal.
  syncPointerShape() {
    const b = this.wasmTerm, e = b?.exports;
    const shape = e?.tessera_mouse_shape
      ? terminalPointerShape(e.tessera_mouse_shape(b.handle)) : defaultTerminalPointerShape;
    if (shape === this.pointerShape) return;
    this.pointerShape = shape;
    this.applyPointerShape();
  }

  // ghostty-web shows "pointer" over a link and "text" elsewhere; the
  // program's shape takes the place of "text".
  applyPointerShape() {
    if (this.element) this.element.style.cursor = this.currentHoveredLink ? "pointer" : this.pointerShape;
  }

  // OSC 133 marks for every row of the active buffer, oldest first (see
  // terminal-prompts.mjs). Empty without the core reader.
  semanticMarks() {
    const core = this.wasmTerm, e = core?.exports;
    const count = this.buffer?.active?.length ?? 0;
    if (!e?.tessera_semantic_rows || !count) return new Uint8Array(0);
    const ptr = e.ghostty_wasm_alloc_u8_array(count);
    try {
      const n = e.tessera_semantic_rows(core.handle, 0, count, ptr);
      return new Uint8Array(e.memory.buffer, ptr, n).slice();
    } finally { e.ghostty_wasm_free_u8_array(ptr, count); }
  }

  // Scrolls the previous (direction < 0) or next prompt to the top of the
  // view, counting from where a scroll in progress is heading. Returns
  // whether there was one.
  scrollToPrompt(direction) {
    const scrollback = this.getScrollbackLength();
    const position = Math.round(this.smoothScroll.target ?? this.viewportY);
    const row = adjacentPrompt(promptStarts(this.semanticMarks()), scrollback - position, direction);
    if (row === null) return false;
    this.smoothScrollTo(Math.max(0, scrollback - row));
    return true;
  }

  // The rows of output of the command entered at the prompt at or above
  // buffer row, or of the last command that printed something; null when
  // there is none.
  commandOutputAt(row = null) {
    const marks = this.semanticMarks();
    return row === null ? lastCommandOutput(marks, this.promptRows()) : commandOutput(marks, row, this.promptRows());
  }

  // What terminal-prompts.mjs asks of the buffer's rows.
  promptRows() {
    const buffer = this.buffer.active;
    return { isBlank: (index) => !buffer.getLine(index)?.translateToString(true).trim() };
  }

  // Selects that output and returns its text ("" when there is none).
  selectCommandOutput(row = null) {
    const output = this.commandOutputAt(row);
    if (!output) return "";
    this.selectRows(output.start, output.end);
    return this.getSelection();
  }

  // Selects whole buffer rows. ghostty-web's selectLines counts rows from the
  // view instead of the buffer, so set its selection directly.
  selectRows(start, end) {
    const manager = this.selectionManager;
    if (!manager) return;
    manager.clearSelection();
    manager.selectionStart = { col: 0, absoluteRow: start };
    manager.selectionEnd = { col: this.cols - 1, absoluteRow: end };
    manager.markCurrentSelectionDirty?.();
    manager.selectionChangedEmitter?.fire();
    this.requestRender();
  }

  // The URI of the OSC 8 link on a cell, rows counted as buffer.active counts
  // them; "" when there is none.
  hyperlinkUriAt(row, col) {
    const core = this.wasmTerm, e = core?.exports;
    if (!e?.tessera_hyperlink_uri) return "";
    // Module-owned like the clipboard buffer; grown for a longer URI.
    this.hyperlinkReadBuffer ??= { exports: e, ptr: e.ghostty_wasm_alloc_u8_array(1024), size: 1024 };
    let buffer = this.hyperlinkReadBuffer;
    let length = e.tessera_hyperlink_uri(core.handle, row, col, buffer.ptr, buffer.size);
    if (length > buffer.size) {
      e.ghostty_wasm_free_u8_array(buffer.ptr, buffer.size);
      buffer = this.hyperlinkReadBuffer = { exports: e, ptr: e.ghostty_wasm_alloc_u8_array(length), size: length };
      length = e.tessera_hyperlink_uri(core.handle, row, col, buffer.ptr, buffer.size);
    }
    return length ? new TextDecoder().decode(new Uint8Array(e.memory.buffer, buffer.ptr, Math.min(length, buffer.size))) : "";
  }

  // The Kitty keyboard protocol flags the program set on the active screen;
  // 0 while it uses ordinary key encoding.
  kittyKeyboardFlags() {
    const core = this.wasmTerm, e = core?.exports;
    return e?.tessera_kitty_keyboard_flags ? e.tessera_kitty_keyboard_flags(core.handle) : 0;
  }

  // Encodes one key event (fields from terminalKittyKeyEvent) with Ghostty's
  // key encoder under the given Kitty flags and the terminal's key modes.
  encodeKeyEvent(fields, kittyFlags) {
    const e = this.wasmTerm?.exports;
    if (!e?.ghostty_key_encoder_encode) return "";
    // Module-owned like the read buffers, so it outlives handle replacement.
    if (this.keyEncoder?.exports !== e) {
      const out = e.ghostty_wasm_alloc_opaque();
      try {
        if (e.ghostty_key_encoder_new(0, out) !== 0) return "";
        this.keyEncoder = { exports: e, handle: new DataView(e.memory.buffer).getUint32(out, true) };
      } finally { e.ghostty_wasm_free_opaque(out); }
    }
    const encoder = this.keyEncoder.handle;
    const option = e.ghostty_wasm_alloc_u8();
    const setOption = (id, value) => {
      new DataView(e.memory.buffer).setUint8(option, value);
      e.ghostty_key_encoder_setopt(encoder, id, option);
    };
    try {
      setOption(5, kittyFlags & 31);
      setOption(0, this.getMode?.(1, false) ? 1 : 0);
      setOption(1, this.getMode?.(66, false) ? 1 : 0);
      setOption(3, this.getMode?.(1036, false) ? 1 : 0);
    } finally { e.ghostty_wasm_free_u8(option); }

    const out = e.ghostty_wasm_alloc_opaque();
    let event = 0;
    try {
      if (e.ghostty_key_event_new(0, out) !== 0) return "";
      event = new DataView(e.memory.buffer).getUint32(out, true);
    } finally { e.ghostty_wasm_free_opaque(out); }
    const text = new TextEncoder().encode(fields.utf8 || "");
    const textPtr = text.length ? e.ghostty_wasm_alloc_u8_array(text.length) : 0;
    const capacity = 128;
    const buffer = e.ghostty_wasm_alloc_u8_array(capacity);
    const written = e.ghostty_wasm_alloc_usize();
    try {
      e.ghostty_key_event_set_action(event, fields.action);
      e.ghostty_key_event_set_key(event, fields.key);
      e.ghostty_key_event_set_mods(event, fields.mods);
      e.ghostty_key_event_set_consumed_mods(event, fields.consumedMods);
      e.ghostty_key_event_set_composing(event, fields.composing ? 1 : 0);
      e.ghostty_key_event_set_unshifted_codepoint(event, fields.unshiftedCodepoint);
      if (textPtr) {
        new Uint8Array(e.memory.buffer).set(text, textPtr);
        e.ghostty_key_event_set_utf8(event, textPtr, text.length);
      }
      if (e.ghostty_key_encoder_encode(encoder, event, buffer, capacity, written) !== 0) return "";
      const length = new DataView(e.memory.buffer).getUint32(written, true);
      return new TextDecoder().decode(new Uint8Array(e.memory.buffer, buffer, Math.min(length, capacity)));
    } finally {
      e.ghostty_wasm_free_usize(written);
      e.ghostty_wasm_free_u8_array(buffer, capacity);
      if (textPtr) e.ghostty_wasm_free_u8_array(textPtr, text.length);
      e.ghostty_key_event_free(event);
    }
  }

  processTerminalResponses() {
    const audioCore = this.wasmTerm;
    const audioExports = audioCore.exports;
    if (audioExports.tessera_audio_read) {
      this.audioReadBuffer ??= { exports: audioExports, ptr: audioExports.ghostty_wasm_alloc_u8_array(4096) };
      while (audioExports.tessera_audio_read(audioCore.handle, this.audioReadBuffer.ptr, 4096)) {}
      while (audioExports.tessera_file_read?.(audioCore.handle, this.audioReadBuffer.ptr, 4096)) {}
      // The host sends notifications to every browser; this copy only drains.
      while (audioExports.tessera_notification_read?.(audioCore.handle, this.audioReadBuffer.ptr, 4096)) {}
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
    this.workingDirectoryRevision = null;
    this.syncPointerShape();
    this.colorRevision = null;
    this.syncColors();
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
    this.linkHover.notePointer(event);
    super.processMouseMove(terminalScrollMouseEvent(this, event));
  }

  // Reports the URI of the OSC 8 link under the pointer, or "" when there is
  // none. See terminal-link-hover.mjs.
  onLinkHover(listener) {
    return this.linkHover.onChange(listener);
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
    this.linkHover.dispose();
    this.workingDirectoryEmitter.clear();
    this.cursorBlink.dispose();
    this.sixelRenderer.clear();
    renderScheduler.unregister(this);
    this.inputBuffer.dispose();
    if (this.clipboardReadBuffer) {
      const { exports, ptr } = this.clipboardReadBuffer;
      this.clipboardReadBuffer = null;
      exports.ghostty_wasm_free_u8_array(ptr, 4096);
    }
    if (this.hyperlinkReadBuffer) {
      const { exports, ptr, size } = this.hyperlinkReadBuffer;
      this.hyperlinkReadBuffer = null;
      exports.ghostty_wasm_free_u8_array(ptr, size);
    }
    if (this.keyEncoder) {
      const { exports, handle } = this.keyEncoder;
      this.keyEncoder = null;
      exports.ghostty_key_encoder_free(handle);
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
