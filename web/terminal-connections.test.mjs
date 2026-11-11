import assert from "node:assert/strict";
import test from "node:test";
import { TerminalConnections } from "./terminal-connections.mjs";
import { signInEndedCloseCode } from "./sign-in.mjs";

function fixture() {
  const sockets = [], effects = [], timers = new Map();
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url) { this.url = url; this.listeners = {}; this.sent = []; this.closes = []; sockets.push(this); }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    emit(type, event = {}) { this.listeners[type](event); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(...args) { this.closes.push(args); }
  }
  const state = { reconnectTimer: null, reconnectAttempts: 0, backlogRecoveryAttempts: 0,
    term: { coreID: "core", cols: 80, rows: 24, resetPredictions: () => effects.push("predictions") },
    replica: { disconnect: () => effects.push("replica-disconnect"),
      receive: bytes => effects.push(["bytes", bytes]), attach: message => effects.push(["attach", message]) } };
  const rect = { id: "pane", kind: "terminal", terminal: state };
  const context = { workspaceID: "workspace", location: { protocol: "http:", host: "localhost" }, authMode: "off" };
  let signIn;
  const controller = new TerminalConnections({ context: () => context, Socket,
    timers: { setTimeout: (callback, delay) => { timers.set(callback, delay); return callback; }, clearTimeout: id => timers.delete(id) },
    opened: () => effects.push("opened"), control: () => false, mouseBridge: () => ({ dispose: () => effects.push("mouse-dispose") }),
    setStatus: (_, status) => { rect.terminalStatus = status; }, disconnectAudio: () => effects.push("audio-disconnect"),
    reauthenticate: () => new Promise(resolve => { signIn = resolve; }), retire: () => effects.push("retire"),
    host: name => effects.push(["host", name]), attached: () => effects.push("attached"),
    fetch: async url => { effects.push(url); },
  });
  return { controller, rect, state, context, sockets, effects, timers, signedIn: () => signIn() };
}

test("terminal socket generations reject old open, message and close events", () => {
  const f = fixture();
  f.controller.connect(f.rect);
  const old = f.sockets[0];
  f.controller.connect(f.rect);
  const live = f.sockets[1];
  f.effects.length = 0;
  old.emit("open");
  old.emit("message", { data: new Uint8Array([1]).buffer });
  old.emit("close", { code: 1006 });
  assert.deepEqual(f.effects, []);
  assert.equal(f.timers.size, 0);
  live.emit("open");
  assert.deepEqual(live.sent, [{ type: "audio-events", enabled: true }]);
  assert.deepEqual(f.effects, ["opened"]);
  f.rect.terminal = null;
  live.emit("open");
  live.emit("close", { code: 1006 });
  assert.deepEqual(f.effects, ["opened"]);
});

test("terminal attachment and binary protocol errors close only the current socket", () => {
  const f = fixture();
  f.controller.connect(f.rect);
  const socket = f.sockets[0];
  f.state.replica.attach = () => { throw new Error("wrong core"); };
  socket.emit("message", { data: JSON.stringify({ type: "attach" }) });
  assert.deepEqual(socket.closes, [[4503, "wrong core"]]);
  f.state.replica.receive = () => { throw new Error("broken frame"); };
  socket.emit("message", { data: new ArrayBuffer(0) });
  assert.deepEqual(socket.closes[1], [4500, "broken frame"]);
  socket.emit("message", { data: "not JSON" });
  assert.equal(socket.closes.length, 2);
});

test("terminal sign-in recovery resumes living panes but never resurrects disposed panes", async () => {
  for (const disposed of [false, true]) {
    const f = fixture();
    f.controller.connect(f.rect);
    f.sockets[0].emit("close", { code: signInEndedCloseCode });
    assert.equal(f.rect.terminalStatus.summary, "Signed out; sign in to reconnect");
    assert.equal(f.timers.size, 0);
    if (disposed) f.rect.terminal = null;
    f.signedIn();
    await Promise.resolve();
    assert.equal(f.sockets.length, disposed ? 1 : 2);
  }
});

test("terminal abnormal closes probe authenticated hosts and retry callbacks respect pane disposal", () => {
  const f = fixture();
  f.context.authMode = "password";
  f.controller.connect(f.rect);
  f.sockets[0].emit("close", { code: 1006 });
  assert.ok(f.effects.includes("/api/users"));
  assert.equal(f.timers.size, 1);
  f.rect.terminal = null;
  [...f.timers.keys()][0]();
  assert.equal(f.sockets.length, 1);
});
