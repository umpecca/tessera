import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { normalizeTerminalBacklogLimit, TerminalReplica } from "./terminal-replica.mjs";
import { terminalBacklogCloseCode, terminalCloseOutcome } from "./terminal-reconnect.mjs";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function loadFunctions(names, globals) {
  const context = vm.createContext(globals);
  for (const name of names) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf("\n}\n", start) + 2;
    vm.runInContext(source.slice(start, end), context);
  }
  return context;
}

function frame(kind, sequence, offset, length) {
  const data = new Uint8Array(21 + length), header = new DataView(data.buffer);
  header.setUint8(0, kind); header.setBigUint64(1, BigInt(sequence), true);
  header.setBigUint64(9, BigInt(offset), true); header.setUint32(17, length, true);
  return data;
}

function pane(retainedOutputBytes, onBacklogExceeded) {
  let tasks = [];
  const term = { coreID: "core", write() {}, restoreSnapshot() {} };
  const scheduler = { enqueueTask(task) { tasks.push(task); }, reset() { tasks = []; } };
  const replica = new TerminalReplica(term, scheduler, "core", undefined, undefined, { backlogLimit: "8", onBacklogExceeded });
  replica.attach({ protocol: 2, core: "core", epoch: "shell", sequence: 3, offset: 12, reset: true, snapshotBytes: 1, retainedOutputBytes });
  replica.receive(frame(4, 3, 12, 1));
  while (tasks.length) tasks.shift()();
  return { id: "pane", kind: "terminal", terminal: { term, replica }, drain() { while (tasks.length) tasks.shift()(); } };
}

test("the device-local setting updates each open replica and recovers only panes exceeding the new limit", () => {
  const recoveries = [], stored = new Map();
  const slow = pane(1, () => recoveries.push("slow"));
  const current = pane(8, () => recoveries.push("current"));
  slow.terminal.replica.receive(frame(1, 4, 14, 2));
  current.terminal.replica.receive(frame(1, 4, 14, 2));
  const context = loadFunctions(["saveBrowserSetting", "setTerminalBacklogLimit"], {
    terminalBacklogLimit: "auto", terminalBacklogLimitStorageKey: "device-key", normalizeTerminalBacklogLimit,
    window: { localStorage: { setItem(key, value) { stored.set(key, value); } } },
    rectangles: [slow, current, { kind: "terminal" }, { kind: "worksheet" }],
  });
  context.setTerminalBacklogLimit("16");
  assert.equal(stored.get("device-key"), "16");
  assert.equal(slow.terminal.replica.maximumBacklogBytes, 16 * 1024 * 1024);
  assert.deepEqual(recoveries, []);
  context.setTerminalBacklogLimit("auto");
  assert.equal(stored.get("device-key"), "auto");
  assert.deepEqual(recoveries, ["slow"]);
  assert.equal(slow.terminal.replica.cursor.sequence, 3);
  assert.equal(current.terminal.replica.queuedOutputBytes, 2);
  current.drain();
  assert.equal(current.terminal.replica.cursor.sequence, 4);
});

test("storage refusal keeps the preference live for the current page", () => {
  const context = loadFunctions(["saveBrowserSetting", "setTerminalBacklogLimit"], {
    terminalBacklogLimit: "auto", terminalBacklogLimitStorageKey: "device-key", normalizeTerminalBacklogLimit,
    window: { localStorage: { setItem() { throw new Error("storage blocked"); } } }, rectangles: [],
  });
  context.setTerminalBacklogLimit("32");
  assert.equal(context.terminalBacklogLimit, "32");
  context.setTerminalBacklogLimit("unlimited");
  assert.equal(context.terminalBacklogLimit, "auto");
});

test("recovery URLs request a fresh snapshot until import, then resume from the applied cursor", () => {
  const rect = pane(1, () => {});
  const context = loadFunctions(["terminalWebSocketURL"], {
    window: { location: { protocol: "http:", host: "localhost:7331" } }, workspaceID: "workspace", URLSearchParams,
  });
  const parameters = () => new URL(context.terminalWebSocketURL(rect, 80, 24)).searchParams;
  assert.equal(parameters().get("resumeSequence"), "3");
  rect.terminal.replica.setBacklogLimit("auto");
  rect.terminal.replica.receive(frame(1, 4, 14, 2));
  assert.equal(rect.terminal.replica.needsSnapshot, true);
  for (const key of ["resumeEpoch", "resumeSequence", "resumeOffset"]) assert.equal(parameters().has(key), false);
  assert.equal(parameters().get("paneId"), "pane", "recovery must reattach to the same shell");
  assert.equal(parameters().get("core"), "core");
  rect.terminal.replica.disconnect();
  assert.equal(parameters().has("resumeEpoch"), false, "ordinary socket teardown must preserve the snapshot request");
  rect.terminal.replica.attach({ protocol: 2, core: "core", epoch: "shell", sequence: 10, offset: 100, reset: true, snapshotBytes: 1 });
  rect.terminal.replica.receive(frame(4, 10, 100, 1));
  assert.equal(parameters().has("resumeEpoch"), false, "received snapshot bytes are not yet applied");
  rect.drain();
  assert.equal(parameters().get("resumeSequence"), "10");
  assert.equal(parameters().get("resumeOffset"), "100");
});

test("successful socket opens do not reset overload backoff, and a quiet interval does", () => {
  const delays = [], closes = [];
  let now = 1000;
  const state = {
    replica: { disconnect() {} }, reconnectTimer: null, reconnectAttempts: 0,
    backlogRecoveryAttempts: 0, lastBacklogRecoveryAt: 0,
    socket: { close(...args) { closes.push(args); } },
  };
  const rect = { terminal: state };
  const context = loadFunctions(["recoverTerminalBacklog", "handleTerminalSocketClose"], {
    terminalBacklogCloseCode, terminalCloseOutcome, Date: { now: () => now }, serverConnectionModal: { hidden: true },
    window: { setTimeout(callback, delay) { delays.push(delay); return 1; } },
    setTerminalStatus() {}, connectTerminalSocket() {},
  });
  for (let attempt = 0; attempt < 7; attempt++) {
    context.recoverTerminalBacklog(rect);
    context.handleTerminalSocketClose(rect, state, { code: terminalBacklogCloseCode });
    // These are the fields reset by the normal socket-open path.
    state.reconnectTimer = null;
    state.reconnectAttempts = 0;
    now += delays.at(-1);
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 10000, 10000]);
  assert.ok(closes.every(([code]) => code === terminalBacklogCloseCode));
  now += 30001;
  context.recoverTerminalBacklog(rect);
  context.handleTerminalSocketClose(rect, state, { code: terminalBacklogCloseCode });
  assert.equal(delays.at(-1), 500);
});
