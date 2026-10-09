import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { TerminalReplica } from "./terminal-replica.mjs";
import { TerminalWriteCoordinator, TerminalWriteScheduler } from "./terminal-write-scheduler.mjs";
import { terminalIsCovered } from "./terminal-visibility.mjs";
import { terminalBacklogCloseCode, terminalCloseOutcome, terminalConnectingStatus, terminalShouldRetry } from "./terminal-reconnect.mjs";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const attachment = { type: "attach", protocol: 2, core: "core", epoch: "shell", sequence: 3, offset: 12, snapshotBytes: 4, reset: true };

function frame(kind, sequence, offset, payload = new Uint8Array()) {
  const result = new Uint8Array(21 + payload.length), header = new DataView(result.buffer);
  header.setUint8(0, kind); header.setBigUint64(1, BigInt(sequence), true);
  header.setBigUint64(9, BigInt(offset), true); header.setUint32(17, payload.length, true);
  result.set(payload, 21);
  return result;
}

function fixture() {
  const sockets = [], calls = [], timers = new Map(), retired = [], audio = [];
  let timerID = 0;
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = Socket.CONNECTING; this.listeners = {}; this.sent = []; this.closes = []; sockets.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    open() { this.readyState = Socket.OPEN; this.listeners.open(); }
    text(message) { this.listeners.message({ data: JSON.stringify(message) }); }
    binary(bytes) { this.listeners.message({ data: bytes.buffer }); }
    send(data) { this.sent.push(data); }
    close(code = 1000, reason = "") { this.closes.push([code, reason]); this.end(code, reason); }
    end(code, reason = "") { this.readyState = Socket.CLOSED; this.listeners.close({ code, reason }); }
  }
  const term = {
    coreID: "core", cols: 80, rows: 24, renderPaused: false,
    setRenderPaused(paused) { this.renderPaused = paused; }, setCursorActive() {}, requestFullRedraw() {},
    focus() { calls.push(["focus"]); },
    ...Object.fromEntries(["write", "restoreSnapshot", "applyGeometry", "applyConfiguration", "applyImageSettings", "clearImages"]
      .map(name => [name, (...args) => calls.push([name, ...args])])),
  };
  const schedule = callback => { const id = ++timerID; timers.set(id, callback); return id; };
  const cancel = id => timers.delete(id);
  const coordinator = new TerminalWriteCoordinator({ schedule, cancelSchedule: cancel, now: () => 0 });
  const output = new TerminalWriteScheduler(data => term.write(data), { coordinator });
  const state = {
    term, output, socket: null, audioKey: "audio-key", outputPaused: false, reconnectTimer: null, reconnectAttempts: 0,
    backlogRecoveryAttempts: 0, lastBacklogRecoveryAt: 0,
  };
  state.replica = new TerminalReplica(term, output, "core", text => calls.push(["clipboard", text]), error => { throw error; });
  const rect = { id: "pane", kind: "terminal", terminal: state,
    element: { contains: () => false, dataset: {}, classList: { add() {}, remove() {} } },
    x: 20, y: 20, width: 100, height: 100, zIndex: 1 };
  const document = { hidden: false, body: {} };
  document.activeElement = document.body;
  const context = vm.createContext({
    WebSocket: Socket, Uint8Array, URLSearchParams, document, rectangles: [rect], activeRect: rect, workspaceID: "workspace",
    activePaneID: rect.id, board: { dataset: {} }, scheduleWorkspaceSave() {}, updateDeskbar() {},
    terminalIsCovered, terminalBacklogCloseCode, terminalCloseOutcome, terminalConnectingStatus, terminalShouldRetry,
    ghosttyModulePromise: null, terminalOutputCoalescing: false, serverConnectionModal: { hidden: true },
    window: { location: { protocol: "http:", host: "localhost:7331" }, setTimeout: schedule, clearTimeout: cancel },
    attachTerminalMouseBridge: () => ({ dispose() {} }), setPaneCwd() {}, sendTerminalGridSize() {},
    terminalAudioPlayer: { receive: (key, event) => audio.push([key, event]), disconnect: key => audio.push([key, "disconnect"]) },
    clearTerminalStatus: target => { target.terminalStatus = null; },
    setTerminalStatus: (target, status) => { target.terminalStatus = status; },
    completeTerminalWakeRecovery: target => retired.push(target),
    destroyRectangle: target => { target.terminal = null; },
    sendTerminalInput: (socket, data) => socket.send(new TextEncoder().encode(data)),
  });
  for (const name of ["setActivePane", "clearActivePane", "clearActivePaneClass", "setTerminalCursorBlink",
    "updateTerminalRenderState", "setTerminalOutputPaused", "updateTerminalDocumentVisibility", "connectTerminalSocket",
    "applyTerminalTextMessage", "handleTerminalAudioMessage", "handleTerminalSocketClose", "retryTerminalNow", "resumeTerminalConnections", "terminalWebSocketURL"]) {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf("\n}\n", start) + 2;
    assert.ok(start >= 0 && end > start, name);
    vm.runInContext(source.slice(start, end), context);
  }
  const drain = () => {
    while (timers.size) {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id); callback();
    }
  };
  function attach(socket, message = attachment, bytes = new Uint8Array(message.snapshotBytes)) {
    socket.text(message);
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      socket.binary(frame(4, message.sequence, message.offset, bytes.subarray(offset, offset + 64 * 1024)));
    }
  }
  function start() { context.connectTerminalSocket(rect); sockets.at(-1).open(); attach(sockets.at(-1)); drain(); calls.length = 0; }
  return { context, rect, state, sockets, calls, audio, timers, retired, document, drain, attach, start };
}

test("pane selection transfers parsing priority and selecting a worksheet clears it", () => {
  const f = fixture(), coordinator = f.state.output.coordinator;
  f.context.updateTerminalRenderState(f.rect);
  assert.equal(coordinator.activeScheduler, f.state.output);
  const other = { id: "other", kind: "terminal", element: { dataset: {}, classList: { add() {}, remove() {} } },
    terminal: { term: { renderPaused: false, setCursorActive() {} }, output: new TerminalWriteScheduler(() => {}, { coordinator }) } };
  const worksheet = { id: "sheet", kind: "worksheet", element: other.element };
  f.context.rectangles.push(other, worksheet);
  f.context.setActivePane(other);
  assert.equal(coordinator.activeScheduler, other.terminal.output);
  f.context.setActivePane(worksheet);
  assert.equal(coordinator.activeScheduler, null);
  f.context.setActivePane(f.rect);
  assert.equal(coordinator.activeScheduler, f.state.output);
  f.context.clearActivePane();
  assert.equal(coordinator.activeScheduler, null);
});

test("file messages reach initially hidden panes and visibility handoff preserves their bridge", () => {
  const f = fixture(), events = [], subscriptions = [];
  f.state.files = { subscribe: socket => subscriptions.push(socket), receive: message => {
    if (message?.type !== "terminal-file") return false;
    events.push(message); return true;
  }, disconnect: () => events.push("disconnect") };
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  f.context.connectTerminalSocket(f.rect); const old = f.sockets[0]; old.open();
  old.text({ type: "terminal-file", epoch: "shell", action: "request", id: "id" });
  assert.equal(events.length, 1); assert.equal(f.state.output.chunks.length, 0);
  f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
  assert.ok(old.sent.some(value => typeof value === "string" && JSON.parse(value).type === "file-handoff"));
  f.sockets[1].open(); assert.equal(subscriptions.length, 2);
  assert.equal(events.includes("disconnect"), false);
  f.sockets[1].end(1006); assert.equal(events.at(-1), "disconnect");
});

test("live audio bypasses hidden text pauses, while stale socket audio is ignored", () => {
  const f = fixture(); f.start();
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  const event = { type: "terminal-audio", epoch: "shell", action: "play", id: "clip", format: "wav", data: "bytes" };
  f.sockets[0].text(event);
  assert.deepEqual(JSON.parse(JSON.stringify(f.audio)), [["audio-key", event]]);
  assert.equal(f.state.replica.cursor.sequence, 3, "audio does not advance the text cursor");
  f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
  f.audio.length = 0;
  f.sockets[0].text(event);
  assert.deepEqual(f.audio, []);
  f.sockets[1].open(); f.sockets[1].text(event);
  assert.equal(f.audio.length, 1);
  f.sockets[1].end(1006);
  assert.deepEqual(f.audio.at(-1), ["audio-key", "disconnect"]);
});

test("active priority follows minimized, covered, and background-tab visibility", () => {
  const f = fixture(); f.start();
  const coordinator = f.state.output.coordinator;
  f.context.updateTerminalRenderState(f.rect);
  assert.equal(coordinator.activeScheduler, f.state.output);
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  assert.equal(coordinator.activeScheduler, null);
  f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
  assert.equal(coordinator.activeScheduler, f.state.output);
  const cover = { kind: "worksheet", x: 0, y: 0, width: 150, height: 150, zIndex: 2 };
  f.context.rectangles.push(cover); f.context.updateTerminalRenderState(f.rect);
  assert.equal(coordinator.activeScheduler, null);
  cover.minimized = true; f.context.updateTerminalRenderState(f.rect);
  assert.equal(coordinator.activeScheduler, f.state.output);
  f.document.hidden = true; f.context.updateTerminalDocumentVisibility();
  f.context.setTerminalCursorBlink(f.rect, true);
  assert.equal(coordinator.activeScheduler, null);
  f.document.hidden = false; f.context.updateTerminalDocumentVisibility();
  assert.equal(coordinator.activeScheduler, f.state.output);
  f.context.activeRect = null; f.context.updateTerminalRenderState(f.rect);
  assert.equal(coordinator.activeScheduler, null);
});

test("minimizing discards pending parsing and 16 MiB of hidden output without closing the live shell socket", () => {
  const f = fixture(); f.start();
  const socket = f.sockets[0];
  socket.binary(frame(1, 4, 14, new Uint8Array([65, 66])));
  assert.equal(f.state.replica.queuedOutputBytes, 2);
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  const payload = new Uint8Array(64 * 1024);
  for (let i = 0; i < 256; i++) socket.binary(frame(1, i + 5, (i + 1) * payload.length + 14, payload));
  // An attachment already in flight cannot allocate or re-enable parsing.
  socket.text({ ...attachment, snapshotBytes: 192 * 1024 * 1024 });
  f.drain();
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.replica.pending, null);
  assert.equal(f.state.replica.queuedOutputBytes, 0);
  assert.equal(f.state.replica.cursor.sequence, 3);
  assert.equal(f.state.replica.needsSnapshot, false, "the host chooses a snapshot for the large gap on reveal");
  assert.equal(f.state.output.chunks.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(socket.readyState, 1);
  assert.deepEqual(socket.closes, []);
});

test("revealing restores a fresh snapshot before ordered live events and rejects the old socket", () => {
  const f = fixture(); f.start();
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  f.sockets[0].binary(frame(1, 4, 14, new Uint8Array([65, 66])));
  f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
  const old = f.sockets[0], current = f.sockets[1];
  const params = new URL(current.url).searchParams;
  assert.equal(params.get("paneId"), "pane");
  assert.equal(params.get("resumeSequence"), "3");
  assert.equal(params.get("catchUpReplay"), "1");
  old.text(attachment); old.binary(frame(1, 4, 14, new Uint8Array([88, 88]))); old.end(4501);
  assert.equal(f.rect.terminal, f.state);
  current.open(); f.calls.length = 0;
  f.attach(current, { ...attachment, sequence: 300, offset: 10000 }, new Uint8Array([1, 2, 3, 4]));
  current.binary(frame(2, 301, 10000, new Uint8Array(new Uint32Array([100, 30, 8, 16]).buffer)));
  current.binary(frame(5, 302, 10000, new Uint8Array([1])));
  current.binary(frame(1, 303, 10002, new Uint8Array([65, 66])));
  assert.equal(f.state.replica.cursor.sequence, 3, "receiving is not applying");
  assert.equal(f.state.replica.needsSnapshot, true);
  f.drain();
  assert.deepEqual(f.calls.map(call => call[0]), ["restoreSnapshot", "applyGeometry", "applyConfiguration", "write"]);
  assert.deepEqual([...f.calls[0][1]], [1, 2, 3, 4]);
  assert.equal(f.state.replica.cursor.sequence, 303);
  assert.equal(f.state.replica.needsSnapshot, false);
  assert.equal(new URL(f.context.terminalWebSocketURL(f.rect, 80, 24)).searchParams.get("resumeSequence"), "303");
  f.context.updateTerminalRenderState(f.rect);
  assert.equal(f.sockets.length, 2, "unchanged visibility must not reconnect again");
});

test("an idle hide and reveal resumes without replacing the terminal contents or view", () => {
  const f = fixture(); f.start();
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  assert.equal(f.state.replica.needsSnapshot, false);
  assert.deepEqual(JSON.parse(f.sockets[0].sent.at(-1)), { type: "pause-output" });
  f.sockets[0].text({ type: "output-paused" });
  assert.equal(f.state.replica.needsSnapshot, false, "pause acknowledgement is not missed state");
  f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
  const socket = f.sockets[1];
  assert.equal(new URL(socket.url).searchParams.get("resumeSequence"), "3");
  assert.equal(new URL(socket.url).searchParams.get("snapshotIfChanged"), "1");
  assert.equal(new URL(socket.url).searchParams.get("catchUpReplay"), "1");
  socket.open(); f.calls.length = 0;
  socket.text({ ...attachment, reset: false, snapshotBytes: 0 }); f.drain();
  assert.equal(f.state.snapshotIfChanged, false);
  assert.deepEqual(f.calls, [], "an unchanged terminal must not import a snapshot");
  socket.binary(frame(1, 4, 14, new Uint8Array([65, 66]))); f.drain();
  assert.deepEqual(f.calls.map(call => call[0]), ["write"]);
});

test("a small gap replays discarded queued output and ordered controls without importing a snapshot", () => {
  const f = fixture(); f.start();
  const old = f.sockets[0];
  old.binary(frame(1, 4, 14, new Uint8Array([65, 66])));
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  old.binary(frame(1, 9, 16, new Uint8Array([67, 68])));
  old.text({ type: "output-paused" });
  assert.equal(f.state.replica.needsSnapshot, false);
  assert.equal(f.state.replica.queuedOutputBytes, 0);
  f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
  const socket = f.sockets[1], params = new URL(socket.url).searchParams;
  assert.equal(params.get("resumeSequence"), "3");
  assert.equal(params.get("resumeOffset"), "12");
  assert.equal(params.get("catchUpReplay"), "1");
  assert.equal(params.get("snapshotIfChanged"), "1", "older hosts still choose snapshots for changed state");
  socket.open(); f.calls.length = 0;
  socket.text({ ...attachment, reset: false, snapshotBytes: 0 });
  socket.binary(frame(1, 4, 14, new Uint8Array([65, 66])));
  socket.binary(frame(2, 5, 14, new Uint8Array(new Uint32Array([90, 30, 8, 16]).buffer)));
  socket.binary(frame(3, 6, 14)); // Historical clipboard effects keep only their sequence.
  socket.binary(frame(5, 7, 14, new Uint8Array([1])));
  socket.binary(frame(6, 8, 14, new Uint8Array([16, 0, 0, 0, 1])));
  socket.binary(frame(1, 9, 16, new Uint8Array([67, 68])));
  assert.equal(f.state.replica.cursor.sequence, 3);
  old.binary(frame(1, 4, 14, new Uint8Array([88, 88]))); old.end(4501);
  f.drain();
  assert.deepEqual(f.calls.map(call => call[0]), ["write", "applyGeometry", "applyConfiguration", "applyImageSettings", "write"]);
  assert.deepEqual(f.calls.filter(call => call[0] === "write").map(call => [...call[1]]), [[65, 66], [67, 68]]);
  assert.equal(f.state.replica.cursor.sequence, 9);
  assert.equal(f.state.replica.cursor.offset, 16);
  assert.equal(f.state.replica.queuedOutputBytes, 0);
  assert.equal(f.state.replica.needsSnapshot, false);
  assert.equal(f.rect.terminal, f.state);
});

test("an interrupted small replay retries with the same bound from its fully applied cutoff", () => {
  const f = fixture(); f.start();
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
  const socket = f.sockets[1]; socket.open(); f.calls.length = 0;
  socket.text({ ...attachment, reset: false, snapshotBytes: 0 });
  f.state.output.coordinator.maximumBytesPerTurn = 2;
  socket.binary(frame(1, 4, 14, new Uint8Array([65, 66])));
  socket.binary(frame(1, 5, 16, new Uint8Array([67, 68])));
  const [id, callback] = f.timers.entries().next().value;
  f.timers.delete(id); callback();
  assert.equal(f.state.replica.cursor.sequence, 4);
  socket.end(1006);
  const retry = new URL(f.context.terminalWebSocketURL(f.rect, 80, 24)).searchParams;
  assert.equal(retry.get("catchUpReplay"), "1");
  assert.equal(retry.get("resumeSequence"), "4");
  assert.equal(retry.get("resumeOffset"), "14");
  f.drain(); const next = f.sockets.at(-1); next.open();
  next.text({ ...attachment, reset: false, snapshotBytes: 0, sequence: 4, offset: 14 });
  next.binary(frame(1, 5, 16, new Uint8Array([67, 68]))); f.drain();
  assert.deepEqual(f.calls.filter(call => call[0] === "write").map(call => [...call[1]]), [[65, 66], [67, 68]]);
  assert.equal(f.state.replica.cursor.sequence, 5);
});

test("a fully received snapshot canceled before import still requires a snapshot on reveal", () => {
  const f = fixture(); f.start();
  f.sockets[0].text(attachment);
  f.sockets[0].binary(frame(4, 3, 12, new Uint8Array(4)));
  assert.equal(f.state.replica.pending, null);
  assert.equal(f.state.replica.queuedSequence, f.state.replica.cursor.sequence);
  assert.equal(f.state.replica.needsSnapshot, true);
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
  const params = new URL(f.sockets[1].url).searchParams;
  assert.equal(params.has("resumeSequence"), false);
  assert.equal(params.has("catchUpReplay"), false);
  f.sockets[1].open(); f.calls.length = 0;
  f.attach(f.sockets[1]); f.drain();
  assert.deepEqual(f.calls.map(call => call[0]), ["restoreSnapshot"]);
  assert.equal(f.state.replica.needsSnapshot, false);
});

test("background visibility suspends parsing synchronously and foreground keeps minimized or covered panes paused", () => {
  const f = fixture(); f.start();
  f.document.hidden = true; f.context.updateTerminalDocumentVisibility();
  assert.equal(f.state.outputPaused, true);
  assert.equal(f.state.term.renderPaused, true);
  f.document.hidden = false; f.rect.minimized = true; f.context.updateTerminalDocumentVisibility();
  assert.equal(f.sockets.length, 1);
  f.rect.minimized = false;
  const cover = { kind: "worksheet", x: 0, y: 0, width: 150, height: 150, zIndex: 2 };
  f.context.rectangles.push(cover);
  f.context.updateTerminalDocumentVisibility();
  assert.equal(f.state.outputPaused, true);
  cover.x = 30; f.context.updateTerminalRenderState(f.rect);
  assert.equal(f.state.outputPaused, false, "partial coverage keeps the terminal live");
  assert.equal(f.sockets.length, 2);
});

test("coverage alone suspends parsing and removing the cover resumes it", () => {
  const f = fixture(); f.start();
  const cover = { kind: "worksheet", x: 0, y: 0, width: 150, height: 150, zIndex: 2 };
  f.context.rectangles.push(cover); f.context.updateTerminalRenderState(f.rect);
  f.sockets[0].binary(frame(1, 4, 14, new Uint8Array([65, 66]))); f.drain();
  assert.deepEqual(f.calls, []);
  cover.minimized = true; f.context.updateTerminalRenderState(f.rect);
  assert.equal(f.state.outputPaused, false);
  assert.equal(f.sockets.length, 2);
});

test("hiding during snapshot reception releases the partial buffer and preserves the applied terminal", () => {
  const f = fixture(); f.start();
  f.sockets[0].text({ ...attachment, sequence: 20, snapshotBytes: 8 });
  f.sockets[0].binary(frame(4, 20, 12, new Uint8Array(4)));
  assert.equal(f.state.replica.pending.offset, 4);
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  f.sockets[0].binary(frame(4, 20, 12, new Uint8Array(4))); f.drain();
  assert.equal(f.state.replica.pending, null);
  assert.equal(f.state.replica.cursor.sequence, 3);
  assert.deepEqual(f.calls, []);
  f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
  f.sockets[1].open(); f.calls.length = 0;
  f.attach(f.sockets[1], { ...attachment, sequence: 30 }); f.drain();
  assert.deepEqual(f.calls.map(call => call[0]), ["restoreSnapshot"]);
  assert.equal(f.state.replica.cursor.sequence, 30);
});

test("a terminal created while hidden starts its shell and startup command once without parsing or stealing focus", () => {
  const f = fixture(); f.rect.minimized = true; f.rect.terminalStartupCommand = "build";
  f.context.updateTerminalRenderState(f.rect); f.context.connectTerminalSocket(f.rect);
  assert.equal(new URL(f.sockets[0].url).searchParams.get("outputPaused"), "1");
  f.sockets[0].open(); f.sockets[0].text({ type: "output-paused" }); f.drain();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(JSON.parse(f.sockets[0].sent[0]), { type: "audio-events", enabled: true });
  assert.deepEqual(JSON.parse(f.sockets[0].sent[1]), { type: "pause-output" });
  assert.equal(new TextDecoder().decode(f.sockets[0].sent[2]), "build\r");
  f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
  f.sockets[1].open(); f.attach(f.sockets[1]); f.drain();
  assert.equal(f.sockets[1].sent.length, 1, "restore subscribes to audio without rerunning the startup command");
  assert.equal(f.state.replica.cursor.epoch, "shell");
});

test("hiding an opening connection pauses delivery when it opens and duplicate visibility updates stay idle", () => {
  const f = fixture(); f.context.connectTerminalSocket(f.rect);
  assert.equal(new URL(f.sockets[0].url).searchParams.has("outputPaused"), false);
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  assert.equal(f.sockets[0].sent.length, 0);
  f.sockets[0].open();
  assert.deepEqual(JSON.parse(f.sockets[0].sent[1]), { type: "pause-output" });
  f.context.updateTerminalRenderState(f.rect);
  f.sockets[0].text({ type: "output-paused" });
  assert.equal(f.sockets[0].sent.length, 2);
  assert.equal(f.state.replica.needsSnapshot, false);
  assert.deepEqual(f.calls, []);
});

test("host changes suppressed on the hidden socket restore a snapshot and partial-import retries stay fresh", () => {
  const f = fixture(); f.start();
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  f.sockets[0].text({ type: "output-paused" });
  // No binary data arrives while hidden. The host compares the supplied cutoff.
  f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
  const socket = f.sockets[1], params = new URL(socket.url).searchParams;
  assert.equal(params.get("snapshotIfChanged"), "1");
  assert.equal(params.get("resumeSequence"), "3");
  assert.equal(params.has("outputPaused"), false);
  socket.open(); f.calls.length = 0;
  socket.text({ ...attachment, sequence: 30, snapshotBytes: 8 });
  socket.binary(frame(4, 30, 12, new Uint8Array(4)));
  assert.equal(f.state.replica.needsSnapshot, true, "a host-selected snapshot stays required until import");
  socket.end(1006);
  const retry = new URL(f.context.terminalWebSocketURL(f.rect, 80, 24)).searchParams;
  assert.equal(retry.has("resumeSequence"), false, "partial snapshot must not fall back to hidden replay");
  f.drain(); const next = f.sockets.at(-1); next.open(); f.calls.length = 0;
  f.attach(next, { ...attachment, sequence: 40 }); f.drain();
  assert.deepEqual(f.calls.map(call => call[0]), ["restoreSnapshot"]);
  assert.equal(f.state.replica.cursor.sequence, 40);
  assert.equal(f.state.replica.needsSnapshot, false);
});

test("hidden shell exits still retire panes and permanent failures never restart their shells on reveal", () => {
  for (const code of [4501, 4502, 4503]) {
    const f = fixture(); f.start();
    f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
    f.sockets[0].end(code, "finished");
    assert.equal(f.timers.size, 0);
    if (code === 4501) assert.equal(f.rect.terminal, null);
    else {
      assert.equal(f.rect.terminalStatus.reconnect, false);
      f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
    }
    assert.equal(f.sockets.length, 1);
  }
});

test("hidden outages cancel retries and health checks wait until reveal to restore the same pane", () => {
  const f = fixture(); f.start(); f.sockets[0].end(1006);
  assert.equal(f.timers.size, 1);
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  assert.equal(f.timers.size, 0);
  assert.equal(f.state.reconnectTimer, null);
  f.context.resumeTerminalConnections(); f.drain();
  assert.equal(f.sockets.length, 1);
  f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
  assert.equal(f.sockets.length, 2);
  assert.equal(new URL(f.sockets[1].url).searchParams.get("paneId"), "pane");
});

test("a socket lost while already hidden records the outage without scheduling a reconnect", () => {
  const f = fixture(); f.start();
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  f.sockets[0].end(1006); f.context.resumeTerminalConnections(); f.drain();
  assert.equal(f.rect.terminalStatus.reconnect, true);
  assert.equal(f.state.reconnectTimer, null);
  assert.equal(f.sockets.length, 1);
  assert.ok(f.retired.includes(f.state), "hidden terminals must not hold wake recovery open");
});

test("wake recovery leaves hidden terminals connected without restarting their parsing", async () => {
  const f = fixture(); f.start();
  f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
  Object.assign(f.context, {
    wakeRecoveryID: 0, wakeRecoveryActive: false, wakeRecoveryHealthReady: false,
    wakeRecoveryTerminals: new Set(), wakeRecoveryStatusHideTimer: null,
    requestTerminalFit() { throw new Error("hidden wake must not fit or reconnect the terminal"); },
    updateWakeRecoveryStatus() {}, checkServerConnection: async () => true,
  });
  const start = source.indexOf("async function recoverAfterBrowserWake("), end = source.indexOf("\n}\n", start) + 2;
  vm.runInContext(source.slice(start, end), f.context);
  await f.context.recoverAfterBrowserWake();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].readyState, 1);
  assert.equal(f.context.wakeRecoveryTerminals.size, 0);
  assert.equal(f.state.replica.accepting, false);
  assert.equal(f.timers.size, 0);
});

async function realTerminalCores() {
  const bytes = readFileSync(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  return Promise.all([0, 1].map(async () => {
    const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
    const e = instance.exports;
    let handle = e.ghostty_terminal_new(80, 24);
    e.tessera_sixel_geometry(handle, 8, 16);
    function input(data, operation) {
      const pointer = e.ghostty_wasm_alloc_u8_array(data.length);
      new Uint8Array(e.memory.buffer).set(data, pointer);
      try { return operation(pointer); }
      finally { e.ghostty_wasm_free_u8_array(pointer, data.length); }
    }
    return {
      write: data => input(data, pointer => e.ghostty_terminal_write(handle, pointer, data.length)),
      snapshot() {
        const length = e.tessera_sixel_snapshot_export(handle);
        assert.ok(length);
        try { return new Uint8Array(e.memory.buffer, e.tessera_sixel_snapshot_data(handle), length).slice(); }
        finally { e.tessera_sixel_snapshot_release(handle); }
      },
      restore(data) {
        const next = input(data, pointer => e.tessera_sixel_snapshot_import(pointer, data.length));
        assert.ok(next); e.ghostty_terminal_free(handle); handle = next;
      },
      state() {
        e.ghostty_render_state_update(handle);
        const pointer = e.ghostty_wasm_alloc_u8_array(80 * 24 * 16);
        e.ghostty_render_state_get_viewport(handle, pointer, 80 * 24);
        const cells = new Uint8Array(e.memory.buffer, pointer, 80 * 24 * 16).slice();
        e.ghostty_wasm_free_u8_array(pointer, cells.length);
        const tileCount = e.tessera_sixel_tiles(handle, 0, 0, 0);
        const tilePtr = e.ghostty_wasm_alloc_u8_array(Math.max(4, tileCount * 28));
        e.tessera_sixel_tiles(handle, 0, tilePtr, tileCount);
        const tiles = new Uint32Array(e.memory.buffer, tilePtr, tileCount * 7).slice();
        e.ghostty_wasm_free_u8_array(tilePtr, Math.max(4, tileCount * 28));
        return { cells, tiles, history: e.ghostty_terminal_get_scrollback_length(handle),
          images: e.tessera_sixel_image_count(handle),
          cursor: [e.ghostty_render_state_get_cursor_x(handle), e.ghostty_render_state_get_cursor_y(handle)] };
      },
      dispose: () => e.ghostty_terminal_free(handle),
    };
  }));
}

test("a hidden build catches up through the real core snapshot, including history, images, and incomplete parser input", async () => {
  const cores = await realTerminalCores();
  const [host, browser] = cores, encoder = new TextEncoder();
  try {
    const f = fixture(); f.start();
    for (const core of cores) core.write(encoder.encode("before hiding\r\n"));
    let browserWrites = 0, restores = 0;
    f.state.term.write = data => { browserWrites++; browser.write(data); };
    f.state.term.restoreSnapshot = data => { restores++; browser.restore(data); };
    const before = browser.state();
    f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
    const output = encoder.encode("building package: ordinary compiler output 0123456789\r\n".repeat(1200));
    let sequence = 3, offset = 12;
    function publish(data) {
      host.write(data); sequence++; offset += data.length;
      f.sockets.at(-1).binary(frame(1, sequence, offset, data)); f.drain();
    }
    for (let i = 0; i < 256; i++) publish(output);
    publish(encoder.encode('\x1b[H\x1bPq"1;1;8;6#1;2;100;0;0!8~\x1b\\\x1b[24;1H\x1b[31'));
    assert.ok(offset > 16 * 1024 * 1024);
    assert.equal(browserWrites, 0);
    assert.deepEqual(browser.state(), before);
    assert.ok(host.state().history > 0);
    assert.equal(host.state().images, 1);
    const snapshot = host.snapshot();
    f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
    f.sockets[1].open();
    f.attach(f.sockets[1], { ...attachment, sequence, offset, snapshotBytes: snapshot.length }, snapshot); f.drain();
    assert.equal(restores, 1);
    assert.equal(browserWrites, 0, "hidden output is restored rather than parsed again");
    assert.deepEqual(browser.state(), host.state());
    publish(encoder.encode("mfinished after restore\r\n"));
    assert.equal(browserWrites, 1);
    assert.deepEqual(browser.state(), host.state(), "incomplete escape parsing continues after restore");
    assert.equal(f.state.replica.cursor.sequence, sequence);
    assert.equal(f.state.replica.queuedOutputBytes, 0);
  } finally { for (const core of cores) core.dispose(); }
});

test("small hidden replay continues real Sixel, UTF-8, alternate-screen, and OSC state without a snapshot import", async () => {
  const cores = await realTerminalCores(), [host, browser] = cores, encoder = new TextEncoder();
  try {
    const f = fixture(); f.start();
    const before = encoder.encode("retained build line\r\n".repeat(300) + '\x1b[H\x1bPq"1;1;8;6#1;2;100;0;0!');
    for (const core of cores) core.write(before);
    f.state.term.write = data => browser.write(data);
    f.state.term.restoreSnapshot = () => { throw new Error("small gap imported a snapshot"); };
    f.rect.minimized = true; f.context.updateTerminalRenderState(f.rect);
    const smile = encoder.encode("😀");
    const output = [encoder.encode("8~\x1b\\\r\n"), smile.subarray(0, 2), smile.subarray(2),
      encoder.encode("\x1b[?1049hALT\x1b[?1049l\x1b]52;c;aG"), encoder.encode("lkZGVu\a\x1b[31")];
    let sequence = 3, offset = 12;
    const replay = [];
    for (const data of output) {
      host.write(data); sequence++; offset += data.length;
      const event = frame(1, sequence, offset, data);
      replay.push(event); f.sockets[0].binary(event); f.drain();
    }
    // The host sanitizes the old clipboard event before replaying it.
    replay.push(frame(3, ++sequence, offset));
    f.rect.minimized = false; f.context.updateTerminalRenderState(f.rect);
    const socket = f.sockets[1]; socket.open(); f.calls.length = 0;
    socket.text({ ...attachment, reset: false, snapshotBytes: 0 });
    for (const event of replay) socket.binary(event);
    f.drain();
    assert.deepEqual(browser.state(), host.state());
    assert.equal(host.state().images, 1);
    assert.ok(host.state().history > 0);
    assert.deepEqual(f.calls, [], "historical clipboard data must not write the system clipboard");
    const after = encoder.encode("mcontinued\x1b[0m\r\n");
    host.write(after); socket.binary(frame(1, ++sequence, offset + after.length, after)); f.drain();
    assert.deepEqual(browser.state(), host.state(), "partial CSI continues identically after catch-up");
    assert.equal(f.state.replica.cursor.sequence, sequence);
    assert.equal(f.state.replica.queuedOutputBytes, 0);
    assert.equal(f.state.replica.needsSnapshot, false);
  } finally { for (const core of cores) core.dispose(); }
});
