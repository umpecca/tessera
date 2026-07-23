import {
  CanvasRenderer,
  CellFlags,
  Terminal as GhosttyTerminal,
  init,
} from "ghostty-web";

import { TerminalRenderScheduler } from "./terminal-render-scheduler.mjs";

const renderScheduler = new TerminalRenderScheduler();

// Ghostty Web currently owns one permanent animation loop per terminal.
// Adapt that private loop here so the rest of Tessera can use explicit
// visibility and activity state without depending on Ghostty internals.
class Terminal extends GhosttyTerminal {
  startRenderLoop() {
    renderScheduler.register(this, () => this.renderScheduledFrame());
  }

  renderScheduledFrame() {
    if (this.isDisposed || !this.isOpen || !this.renderer || !this.wasmTerm) {
      renderScheduler.unregister(this);
      return;
    }
    this.renderer.render(
      this.wasmTerm,
      false,
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
    renderScheduler.request(this);
    if (callback) {
      globalThis.requestAnimationFrame(callback);
    }
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
