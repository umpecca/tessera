import assert from "node:assert/strict";
import test from "node:test";
import { TerminalAudioPlayer, clipBytes, terminalAudioLimits, terminalAudioMuteKey } from "./terminal-audio.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
const data = Buffer.from("ID3test audio").toString("base64");
const play = (id, extra = {}) => ({ type: "terminal-audio", epoch: "shell", action: "play", id, format: "mp3", data, ...extra });
const control = (action, id = "*") => ({ type: "terminal-audio", epoch: "shell", action, id });

function fixture({ deferred = false, buffer = { duration: 0.1, numberOfChannels: 1, length: 4800 } } = {}) {
  const nodes = [], pending = [], statuses = [];
  const context = {
    state: "suspended", destination: {},
    async resume() { this.state = "running"; }, async close() { this.state = "closed"; },
    decodeAudioData(bytes) {
      assert.ok(bytes instanceof ArrayBuffer);
      if (!deferred) return Promise.resolve(buffer);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; },
    createBufferSource() {
      const node = { buffer: null, started: false, stopped: false, connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
      nodes.push(node); return node;
    },
  };
  const player = new TerminalAudioPlayer({ createContext: () => context });
  player.attach("a", { onStatus: status => statuses.push(status) });
  player.attach("b");
  return { player, context, nodes, pending, statuses, buffer };
}

test("activation drops old clips and each browser has independent enable/mute", async () => {
  const a = fixture(), b = fixture();
  a.player.receive("a", play("old"));
  assert.equal(a.player.context, null);
  assert.equal(a.statuses.at(-1).kind, "enable");
  await a.player.enable(); await flush();
  assert.equal(a.nodes.length, 0);
  a.player.receive("a", play("live")); b.player.receive("a", play("live")); await flush();
  assert.equal(a.nodes.length, 1); assert.equal(b.nodes.length, 0);
  a.player.setMuted("a", true);
  assert.equal(a.nodes[0].stopped, true);
  a.player.receive("a", play("muted")); await flush(); assert.equal(a.nodes.length, 1);
  a.player.setMuted("a", false); await flush(); assert.equal(a.nodes.length, 1);
  a.player.receive("a", play("future")); await flush(); assert.equal(a.nodes.length, 2);
  assert.notEqual(terminalAudioMuteKey("ab", "c"), terminalAudioMuteKey("a", "bc"));
});

test("clips mix with targeted stop, replacement, per-terminal and page eviction", async () => {
  const f = fixture(); await f.player.enable();
  for (let i = 0; i < 4; i++) f.player.receive("a", play(String(i)));
  await flush(); assert.equal(f.player.playing.length, 4);
  f.player.receive("a", play("4")); await flush();
  assert.equal(f.nodes[0].stopped, true); assert.equal(f.player.playing.length, 4);
  f.player.receive("a", play("4")); await flush(); assert.equal(f.nodes[4].stopped, true);
  f.player.receive("a", control("stop", "2")); assert.equal(f.nodes[2].stopped, true);
  assert.ok(f.player.playing.every(clip => clip.id !== "2"));
  for (let pane = 0; pane < 5; pane++) {
    const key = "pane"+pane; f.player.attach(key);
    for (let i = 0; i < 4; i++) f.player.receive(key, play(String(i)));
    await flush();
  }
  assert.equal(f.player.playing.length, 16);
  assert.equal(f.player.playing.filter(clip => clip.terminal.key === "a").length, 0);
  f.player.receive("pane4", control("stop"));
  assert.equal(f.player.playing.filter(clip => clip.terminal.key === "pane4").length, 0);
  f.player.dispose(); assert.equal(f.player.playing.length, 0); assert.equal(f.player.decodedBytes, 0);
});

test("stop, mute, replacement, reset, disconnect and dispose cancel pending decoding", async () => {
  for (const cancel of [f => f.player.receive("a", control("stop", "x")), f => f.player.setMuted("a", true),
    f => f.player.receive("a", control("reset")), f => f.player.disconnect("a"), f => f.player.detach("a"), f => f.player.disable(), f => f.player.dispose()]) {
    const f = fixture({ deferred: true }); await f.player.enable();
    f.player.receive("a", play("x")); await flush(); assert.equal(f.pending.length, 1);
    cancel(f); f.pending[0].resolve(f.buffer); await flush();
    assert.equal(f.nodes.length, 0); assert.equal(f.player.waitingBytes, 0);
  }
  const f = fixture({ deferred: true }); await f.player.enable();
  f.player.receive("a", play("x")); await flush();
  f.player.receive("a", play("x")); await flush();
  f.pending[0].resolve(f.buffer); f.pending[1].resolve(f.buffer); await flush();
  assert.equal(f.nodes.length, 1);
});

test("decoding and waiting buffers remain bounded under bursts", async () => {
  const f = fixture({ deferred: true }); await f.player.enable();
  const large = Buffer.alloc(terminalAudioLimits.clipBytes); large.write("ID3");
  for (let i = 0; i < 12; i++) f.player.receive("a", play(String(i), { data: large.toString("base64") }));
  await flush();
  assert.equal(f.pending.length, 2); assert.equal(f.player.decoding, 2);
  assert.ok(f.player.waitingBytes <= terminalAudioLimits.waitingBytes);
  assert.equal(f.player.waiting.length, 4);
  assert.ok(f.player.waiting.every(clip => Number(clip.id) >= 8), "oldest waiting clips were dropped");
  f.player.disable();
  for (const job of f.pending) job.resolve(f.buffer);
  await flush(); assert.equal(f.player.decoding, 0); assert.equal(f.nodes.length, 0);
});

test("invalid clips, channel/duration limits and decode failures surface without playback", async () => {
  for (const buffer of [{ duration: 11, numberOfChannels: 1, length: 4800 }, { duration: 1, numberOfChannels: 3, length: 4800 }]) {
    const f = fixture({ buffer }); await f.player.enable(); f.player.receive("a", play("x")); await flush();
    assert.equal(f.nodes.length, 0); assert.equal(f.statuses.at(-1).kind, "error");
  }
  const f = fixture({ deferred: true }); await f.player.enable();
  f.player.receive("a", play("invalid", { data: "!!!" })); assert.equal(f.statuses.at(-1).kind, "error");
  f.player.receive("a", play("x")); await flush(); f.pending[0].reject(new Error("decoder rejected audio")); await flush();
  assert.equal(f.nodes.length, 0); assert.equal(f.player.terminals.get("a").clips.size, 0);
  assert.throws(() => clipBytes("ogg", data));
});

test("decoded buffer budget evicts oldest playing clips", async () => {
  const f = fixture({ buffer: { duration: 10, numberOfChannels: 2, length: 1_000_000 } }); await f.player.enable();
  for (let i = 0; i < 6; i++) { f.player.receive(i % 2 ? "a" : "b", play(String(i))); await flush(); }
  assert.equal(f.player.playing.length, 4);
  assert.ok(f.player.decodedBytes <= terminalAudioLimits.decodedBytes);
  assert.ok(f.nodes[0].stopped && f.nodes[1].stopped);
});

test("disable while activation is pending cannot re-enable playback", async () => {
  const f = fixture(); let resume;
  f.context.resume = () => new Promise(resolve => { resume = resolve; });
  const enabling = f.player.enable(); f.player.disable();
  f.context.state = "running"; resume(); await enabling;
  assert.equal(f.player.enabled, false);
});

test("activation failures offer a visible retry and retain no clips", async () => {
  for (const reject of [true, false]) {
    const f = fixture();
    f.context.resume = async () => { if (reject) throw new Error("blocked"); };
    await assert.rejects(f.player.enable(), /could not start/);
    assert.equal(f.player.enabled, false);
    assert.match(f.statuses.at(-1).text, /could not start/);
    assert.equal(f.statuses.at(-1).kind, "enable");
    assert.equal(f.player.playing.length, 0);
  }
});

test("a failed source start releases its buffer and clip budget", async () => {
  const f = fixture(); await f.player.enable();
  const create = f.context.createBufferSource;
  f.context.createBufferSource = () => {
    const node = create(); node.start = () => { throw new Error("start failed"); }; return node;
  };
  f.player.receive("a", play("x")); await flush();
  assert.equal(f.player.playing.length, 0);
  assert.equal(f.player.decodedBytes, 0);
  assert.equal(f.player.terminals.get("a").clips.size, 0);
  assert.equal(f.nodes[0].buffer, null);
  assert.equal(f.statuses.at(-1).kind, "error");
});
