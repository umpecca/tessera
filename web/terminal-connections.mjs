import { terminalBacklogCloseCode, terminalCloseOutcome, terminalConnectingStatus, terminalShouldRetry } from "./terminal-reconnect.mjs";
import { signInEndedCloseCode } from "./sign-in.mjs";

// Owns WebSocket generations, replay attachment and retry policy. Rendering,
// focus, clipboard/audio presentation and pane destruction are explicit hooks.
export class TerminalConnections {
  constructor({ context, opened, control, mouseBridge, setStatus,
    disconnectAudio, reauthenticate, retire, host, attached,
    Socket = globalThis.WebSocket, timers = globalThis, fetch = (...args) => globalThis.fetch(...args) }) {
    Object.assign(this, { context, opened, control, mouseBridge, setStatus,
      disconnectAudio, reauthenticate, retire, host, attached, Socket, timers, fetch });
  }

  url(rect, cols, rows, colorMode = "") {
    const { workspaceID, location, watch } = this.context();
    const params = new URLSearchParams({
      workspaceId: workspaceID, paneId: rect.id, cwd: rect.cwd || "",
      cols: String(cols || 80), rows: String(rows || 24), protocol: "2", core: rect.terminal.term.coreID,
    });
    if (colorMode === "dark" || colorMode === "light") params.set("colorMode", colorMode);
    const state = rect.terminal, stream = state.replica?.cursor;
    if (state.outputPaused) params.set("outputPaused", "1");
    if (watch) params.set("watch", "1");
    if (state.snapshotIfChanged) params.set("snapshotIfChanged", "1");
    // Resume only fully applied output. Partial snapshots always request a new
    // snapshot, and hidden attachments retain the cursor without advancing it.
    if (stream?.epoch && !state.replica.needsSnapshot) {
      params.set("catchUpReplay", "1"); params.set("resumeEpoch", stream.epoch);
      params.set("resumeOffset", String(stream.offset)); params.set("resumeSequence", String(stream.sequence));
    }
    return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/terminal?${params}`;
  }

  connect(rect) {
    const state = rect?.terminal;
    if (!state?.term || rect.kind !== "terminal") return;
    state.reconnectTimer = null;
    if (rect.terminalStatus) this.setStatus(rect, terminalConnectingStatus(rect.terminalStatus));
    const { term } = state;
    state.replica.disconnect();
    const socket = new this.Socket(this.url(rect, term.desiredCols || term.cols, term.desiredRows || term.rows,
      rect.terminalColorMode || this.context().colorMode));
    socket.binaryType = "arraybuffer";
    state.socket = socket;
    state.sentCols = 0; state.sentRows = 0;
    state.mouseBridge?.dispose?.();
    state.mouseBridge = this.mouseBridge(rect, term, socket);
    const current = () => rect.terminal === state && state.socket === socket;
    socket.addEventListener("open", () => {
      if (!current()) return;
      state.reconnectAttempts = 0;
      socket.send(JSON.stringify({ type: "audio-events", enabled: true }));
      state.focusSent = null;
      this.opened(rect, state, socket);
    });
    socket.addEventListener("message", event => {
      if (!current()) return;
      if (typeof event.data === "string") {
        let message; try { message = JSON.parse(event.data); } catch { /* not a control */ }
        if (state.files?.receive(message) || this.control(rect, state, message, event.data)) return;
      }
      if (state.outputPaused) return;
      if (typeof event.data === "string") { this.text(rect, state, event.data); return; }
      state.term?.noteOutputArrival?.();
      try { state.replica.receive(new Uint8Array(event.data)); }
      catch (error) { socket.close(4500, error.message.slice(0, 100)); }
    });
    socket.addEventListener("close", event => { if (current()) this.closed(rect, state, event); });
  }

  text(rect, state, data) {
    if (state.outputPaused) return;
    let message; try { message = JSON.parse(data); } catch { return; }
    if (message?.type === "timing") { state.replica.timing?.host(message); return; }
    if (message?.type !== "attach") return;
    if (typeof message.host === "string") this.host(message.host);
    try { state.replica.attach(message); }
    catch (error) { state.socket?.close(4503, error.message.slice(0, 100)); return; }
    state.snapshotIfChanged = false;
    this.attached(state);
  }

  closed(rect, state, event) {
    state.term?.resetPredictions?.();
    this.disconnectAudio(state.audioKey);
    state.files?.disconnect(); state.replica?.disconnect();
    if (state.reconnectTimer !== null) return;
    if (event?.code === signInEndedCloseCode) {
      this.setStatus(rect, { state: "disconnected", summary: "Signed out; sign in to reconnect", reconnect: false, settled: true, showBadge: true });
      void this.reauthenticate().then(() => { if (rect.terminal === state) this.connect(rect); });
      return;
    }
    const context = this.context();
    if (context.authMode !== "off" && event?.code === 1006) void this.fetch("/api/users").catch(() => {});
    const outcome = terminalCloseOutcome(event, {
      attempt: event?.code === terminalBacklogCloseCode ? state.backlogRecoveryAttempts++ : state.reconnectAttempts,
      serverReported: context.serverReported,
    });
    if (outcome.closesPane) { this.retire(rect); return; }
    this.setStatus(rect, outcome);
    if (!outcome.reconnect || state.outputPaused) return;
    state.reconnectAttempts += 1;
    state.reconnectTimer = this.timers.setTimeout(() => {
      state.reconnectTimer = null;
      if (rect.terminal === state) this.connect(rect);
    }, outcome.delay);
  }

  retry(rect) {
    const state = rect?.terminal;
    if (!state || state.outputPaused || !terminalShouldRetry(rect.terminalStatus)) return;
    const socket = state.socket;
    if (socket?.readyState === this.Socket.OPEN) return;
    if (state.reconnectTimer !== null) {
      this.timers.clearTimeout(state.reconnectTimer); state.reconnectTimer = null;
    }
    if (socket?.readyState === this.Socket.CONNECTING) socket.close();
    state.reconnectAttempts = 0;
    this.connect(rect);
  }
}
