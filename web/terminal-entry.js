import {
  CanvasRenderer,
  CellFlags,
  Terminal as GhosttyTerminal,
  init,
} from "ghostty-web";

import { TerminalRenderScheduler } from "./terminal-render-scheduler.mjs";
import {
  PrimaryDeviceAttributesQueryParser,
  primaryDeviceAttributesResponse,
} from "./terminal-device-attributes.mjs";

const renderScheduler = new TerminalRenderScheduler();

// Ghostty Web currently owns one permanent animation loop per terminal.
// Adapt that private loop here so the rest of Tessera can use explicit
// visibility and activity state without depending on Ghostty internals.
class Terminal extends GhosttyTerminal {
  constructor(options) {
    super(options);
    this.primaryDeviceAttributes = new PrimaryDeviceAttributesQueryParser();
  }

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
    const completionOffsets = this.primaryDeviceAttributes.write(data);
    let start = 0;
    for (const end of completionOffsets) {
      // Stop at each complete query so Ghostty-generated replies to neighboring
      // queries retain their wire order around Tessera's DA1 reply.
      super.write(data.slice(start, end));
      // `input(..., true)` emits onData without writing the response to the
      // screen. Tessera's existing onData bridge sends it to the current PTY.
      super.input(primaryDeviceAttributesResponse, true);
      start = end;
    }
    if (start < data.length) {
      super.write(data.slice(start));
    }
    renderScheduler.request(this);
    if (callback) {
      globalThis.requestAnimationFrame(callback);
    }
  }

  reset() {
    this.primaryDeviceAttributes.reset();
    super.reset();
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
