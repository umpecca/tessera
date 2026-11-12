import assert from "node:assert/strict";
import test from "node:test";

import { createRDPH264Presenter, rdpH264ProbeCodec, rdpH264Supported, rdpH264View } from "./rdp-h264.mjs";

const hex = (value) => Uint8Array.from(value.match(/../g).map((byte) => Number.parseInt(byte, 16)));

// An SPS without VUI (POC type 2), its low-delay rewrite, and a second SPS.
const sps = "67640020acb200980a32";
const lowDelaySps = "67640020acb200980a340368201092";
const otherSps = "67640020acd9404c0519";
const idr = (spsHex = sps) => hex(`0000000109f000000001${spsHex}0000000168ebe3cb22c0000001658884`);
const idrWithoutSps = () => hex("0000000109f0000001658884");
const delta = () => hex("0000000109f0000001419a00");

function fakes() {
  const decoders = [];
  const draws = [];
  const sources = [];
  class FakeVideoDecoder {
    constructor({ output, error }) {
      this.output = output;
      this.error = error;
      this.state = "unconfigured";
      this.chunks = [];
      decoders.push(this);
    }
    configure(config) {
      this.config = config;
      this.state = "configured";
    }
    decode(chunk) {
      this.chunks.push(chunk);
    }
    close() {
      this.state = "closed";
    }
    // Delivers the picture for the chunk at `index`.
    emit(index) {
      const picture = { timestamp: this.chunks[index].timestamp, closed: false, closeCalls: 0,
        close() { this.closed = true; this.closeCalls++; } };
      this.output(picture);
      return picture;
    }
  }
  class FakeEncodedVideoChunk {
    constructor(init) {
      Object.assign(this, init);
    }
  }
  const canvas = {
    name: "pane",
    width: 1024,
    height: 768,
    getContext: () => ({
      drawImage: (source, ...args) => {
        sources.push(source);
        draws.push(args);
      },
    }),
  };
  return { decoders, draws, sources, canvas, VideoDecoder: FakeVideoDecoder, EncodedVideoChunk: FakeEncodedVideoChunk };
}

function presenter(env, options = {}) {
  return createRDPH264Presenter({ canvas: env.canvas, VideoDecoder: env.VideoDecoder, EncodedVideoChunk: env.EncodedVideoChunk, ...options });
}

test("waits for a key frame with an SPS before decoding", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(delta(), Uint16Array.of(0, 0, 16, 16));
  h264.push(idrWithoutSps(), Uint16Array.of(0, 0, 16, 16));
  assert.equal(env.decoders.length, 0);
  h264.push(idr(), Uint16Array.of(0, 0, 16, 16));
  assert.equal(env.decoders.length, 1);
  assert.equal(env.decoders[0].config.codec, "avc1.640020");
  assert.equal(env.decoders[0].config.optimizeForLatency, true);
  assert.deepEqual(env.decoders[0].chunks.map((chunk) => chunk.type), ["key"]);
});

test("decodes the rewritten SPS so pictures are not held back", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 16, 16));
  const sent = Buffer.from(env.decoders[0].chunks[0].data).toString("hex");
  assert.ok(sent.includes(lowDelaySps), sent);
  assert.ok(!sent.includes(`${sps}0000`), sent);
});

test("draws each region of a decoded picture and closes it", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 32, 16, 40, 8, 8, 24));
  const picture = env.decoders[0].emit(0);
  assert.deepEqual(env.draws, [
    [0, 0, 32, 16, 0, 0, 32, 16],
    [40, 8, 8, 24, 40, 8, 8, 24],
  ]);
  assert.equal(picture.closed, true);
});

test("decodes a picture without regions but draws nothing", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), new Uint16Array());
  const picture = env.decoders[0].emit(0);
  assert.equal(env.decoders[0].chunks.length, 1);
  assert.deepEqual(env.draws, []);
  assert.equal(picture.closed, true);
});

test("draws pictures with their own regions, in the order they were pushed", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  h264.push(delta(), Uint16Array.of(8, 8, 4, 4));
  const decoder = env.decoders[0];
  assert.deepEqual(decoder.chunks.map((chunk) => chunk.type), ["key", "delta"]);
  decoder.emit(1);
  assert.deepEqual(env.draws, [], "a picture waits for the one pushed before it");
  decoder.emit(0);
  assert.deepEqual(env.draws, [
    [0, 0, 8, 8, 0, 0, 8, 8],
    [8, 8, 4, 4, 8, 8, 4, 4],
  ]);
});

test("keeps the decoder for a repeated SPS and opens a new one for a changed SPS", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  assert.equal(env.decoders.length, 1);
  h264.push(idr(otherSps), Uint16Array.of(0, 0, 8, 8));
  assert.equal(env.decoders.length, 2);
  assert.equal(env.decoders[0].state, "closed");
  assert.equal(env.decoders[1].chunks.length, 1);
});

test("after a decoder error, resumes at the next key frame", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  env.decoders[0].error(new Error("decode failed"));
  assert.equal(env.decoders[0].state, "closed");
  h264.push(delta(), Uint16Array.of(0, 0, 8, 8));
  assert.equal(env.decoders.length, 1);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  assert.equal(env.decoders.length, 2);
});

test("late errors from a replaced or closed decoder cannot reset its replacement", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  h264.push(idr(otherSps), Uint16Array.of(0, 0, 8, 8));
  env.decoders[0].error(new Error("late old decoder error"));
  assert.equal(env.decoders[1].state, "configured");
  assert.equal(h264.stats().errors, 0);
  env.decoders[1].emit(0);
  assert.equal(env.draws.length, 1);
  h264.close();
  env.decoders[1].error(new Error("late closed decoder error"));
  assert.equal(h264.stats().errors, 0);
});

test("after a decode call throws, resumes at the next key frame", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  env.decoders[0].decode = () => {
    throw new Error("closed");
  };
  h264.push(delta(), Uint16Array.of(0, 0, 8, 8));
  assert.equal(env.decoders[0].state, "closed");
  h264.push(delta(), Uint16Array.of(0, 0, 8, 8));
  assert.equal(env.decoders.length, 1);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  assert.equal(env.decoders.length, 2);
});

test("reports the first drawn picture once", () => {
  const env = fakes();
  let reports = 0;
  const h264 = presenter(env, { onFirstPicture: () => { reports += 1; } });
  h264.push(idr(), new Uint16Array());
  env.decoders[0].emit(0);
  assert.equal(reports, 0);
  h264.push(delta(), Uint16Array.of(0, 0, 8, 8));
  h264.push(delta(), Uint16Array.of(0, 0, 8, 8));
  env.decoders[0].emit(1);
  env.decoders[0].emit(2);
  assert.equal(reports, 1);
});

test("does not skip a delayed picture when later decoded pictures pile up", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  for (let i = 0; i < 20; i += 1) h264.push(delta(), Uint16Array.of(0, 0, 8, 8));
  for (let i = 1; i <= 8; i += 1) env.decoders[0].emit(i);
  assert.deepEqual(env.draws, []);
  env.decoders[0].emit(9);
  assert.equal(env.draws.length, 0, "later damage cannot overtake missing output");
  env.decoders[0].emit(0);
  assert.equal(env.draws.length, 10);
  assert.equal(h264.stats().dropped, 0);
  h264.close();
});

test("ends the view instead of dropping deltas when the decoder never outputs", () => {
  const env = fakes();
  let exceeded = 0;
  const h264 = presenter(env, { onBacklogExceeded: () => { exceeded++; } });
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  for (let i = 0; i < 100; i += 1) h264.push(delta(), Uint16Array.of(0, 0, 8, 8));
  const forgotten = env.decoders[0].emit(0);
  assert.equal(forgotten.closed, true);
  assert.deepEqual(env.draws, []);
  assert.equal(exceeded, 1);
  assert.equal(env.decoders[0].chunks.length, 64, "admission is bounded even without decoder output");
  assert.equal(h264.stats().backlog, 0);
});

test("ignores pictures after close", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  h264.close();
  assert.equal(env.decoders[0].state, "closed");
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  assert.equal(env.decoders.length, 1);
});

test("detects H.264 support only in a secure context with WebCodecs", async () => {
  const supported = { isConfigSupported: async (config) => ({ supported: config.codec === rdpH264ProbeCodec }) };
  assert.equal(await rdpH264Supported({ isSecureContext: true, VideoDecoder: supported }), true);
  assert.equal(await rdpH264Supported({ isSecureContext: false, VideoDecoder: supported }), false);
  assert.equal(await rdpH264Supported({ isSecureContext: true }), false);
  assert.equal(await rdpH264Supported({ isSecureContext: true, VideoDecoder: { isConfigSupported: async () => ({ supported: false }) } }), false);
  assert.equal(await rdpH264Supported({ isSecureContext: true, VideoDecoder: { isConfigSupported: async () => { throw new Error("no"); } } }), false);
});

const { main, auxiliary, v2, auxiliaryFollows } = rdpH264View;

// A combiner that records what it is asked to do.
function fakeCombiner() {
  const calls = [];
  return {
    calls,
    canvas: { name: "combined" },
    width: 64,
    height: 48,
    applyMain: (planes, regions) => calls.push(["main", planes.id, regions]),
    applyAuxiliary: (layout, planes, regions) => calls.push(["auxiliary", layout, planes.id, regions]),
    paint: (regions) => calls.push(["paint", regions]),
    lost: () => false,
    close: () => calls.push(["close"]),
  };
}

function fullColorPresenter(env, options = {}) {
  const combiner = fakeCombiner();
  let reads = 0;
  const h264 = presenter(env, {
    fullColor: true,
    createCombiner: () => combiner,
    readPlanes: async () => ({ id: reads++, data: new Uint8Array(1) }),
    ...options,
  });
  return { h264, combiner };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("bounds the entire pipeline when an AVC444 plane copy never settles", async () => {
  const env = fakes();
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const pressure = [];
  let exceeded = 0, reads = 0;
  const { h264, combiner } = fullColorPresenter(env, {
    readPlanes: () => { reads++; return blocked; },
    onPressure: behind => pressure.push(behind),
    onBacklogExceeded: () => { exceeded++; },
  });
  const pictures = [];
  h264.push(idr(), Uint16Array.of(0, 0, 16, 16), main);
  pictures.push(env.decoders[0].emit(0));
  for (let i = 1; i < 64; i++) {
    h264.push(delta(), Uint16Array.of(0, 0, 16, 16), main);
    pictures.push(env.decoders[0].emit(i));
  }
  assert.equal(reads, 1, "only one async copy runs, without a chain per picture");
  assert.equal(h264.stats().waiting, 0);
  assert.equal(h264.stats().compositing, 64);
  assert.equal(h264.stats().backlog, 64);
  assert.deepEqual(pressure, [true]);
  assert.equal(exceeded, 0);
  h264.push(delta(), Uint16Array.of(0, 0, 16, 16), main);
  assert.equal(exceeded, 1);
  assert.equal(env.decoders[0].chunks.length, 64);
  assert.ok(pictures.every(picture => picture.closeCalls === 1), "close releases even the in-progress copy immediately");
  assert.equal(h264.stats().compositing, 0);
  assert.equal(h264.stats().queuedBytes, 0);
  for (let i = 0; i < 200; i++) h264.push(delta(), new Uint16Array(), main);
  assert.equal(exceeded, 1, "overflow is reported once");
  unblock({ id: 0, data: new Uint8Array(1) });
  await settle();
  assert.deepEqual(combiner.calls, [["close"]], "late copy completion cannot touch the combiner");
  assert.deepEqual(env.draws, []);
  assert.ok(pictures.every(picture => picture.closeCalls === 1));
  assert.equal(h264.stats().presented, 0);
});

test("pressure has hysteresis and clears as ordered presentation catches up", async () => {
  const env = fakes();
  const pressure = [];
  const copies = [];
  const timers = new Map();
  let nextTimer = 0;
  const { h264 } = fullColorPresenter(env, {
    readPlanes: () => new Promise(resolve => copies.push(resolve)),
    onPressure: behind => pressure.push(behind),
    setTimer: (callback, delay) => {
      assert.equal(delay, 5000);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimer: timer => timers.delete(timer),
  });
  const pictures = [];
  for (let i = 0; i < 8; i++) {
    h264.push(i ? delta() : idr(), Uint16Array.of(i, 0, 1, 1), main);
    pictures.push(env.decoders[0].emit(i));
  }
  assert.deepEqual(pressure, [true]);
  assert.equal(h264.stats().backpressured, true);
  assert.equal(timers.size, 1);
  for (let i = 0; i < 8; i++) {
    assert.equal(copies.length, i + 1);
    copies[i]({ id: i, data: new Uint8Array(1) });
    await settle();
    assert.deepEqual(pressure, i < 5 ? [true] : [true, false]);
    assert.equal(timers.size, i < 5 ? 1 : 0, "progress rearms the watchdog; catching up cancels it");
  }
  assert.equal(h264.stats().backlog, 0);
  assert.equal(h264.stats().compositing, 0);
  assert.equal(h264.stats().backpressured, false);
  assert.equal(h264.stats().dropped, 0);
  assert.deepEqual(env.draws.map(args => args[0]), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(pictures.every(picture => picture.closeCalls === 1));
  h264.close();
});

test("a paused pipeline with no progress recovers without further video arrivals", async () => {
  for (const stalledCopy of [false, true]) {
    const env = fakes();
    let expire, unblock;
    let exceeded = 0, cleared = 0;
    const blocked = new Promise(resolve => { unblock = resolve; });
    const { h264 } = fullColorPresenter(env, {
      readPlanes: () => blocked,
      onBacklogExceeded: () => { exceeded++; },
      setTimer: (callback, delay) => { assert.equal(delay, 5000); expire = callback; return 1; },
      clearTimer: () => { cleared++; },
    });
    const pictures = [];
    for (let i = 0; i < 8; i++) {
      h264.push(i ? delta() : idr(), Uint16Array.of(0, 0, 16, 16), main);
      if (stalledCopy) pictures.push(env.decoders[0].emit(i));
    }
    assert.equal(h264.stats().backpressured, true);
    assert.equal(h264.stats().backlog, 8, "the server can pause below the hard limit");
    expire();
    assert.equal(exceeded, 1);
    assert.equal(h264.stats().backlog, 0);
    assert.equal(env.decoders[0].state, "closed");
    assert.ok(pictures.every(picture => picture.closeCalls === 1));
    assert.equal(cleared, 0, "the expired timer is not left armed");
    unblock(null);
    await settle();
    assert.deepEqual(env.draws, []);
    assert.equal(exceeded, 1);
  }
});

test("closing releases active, queued and out-of-order pictures before a copy finishes", async () => {
  for (const rejected of [false, true]) {
    const env = fakes();
    let resolve, reject;
    const blocked = new Promise((done, fail) => { resolve = done; reject = fail; });
    const { h264, combiner } = fullColorPresenter(env, { readPlanes: () => blocked });
    for (let i = 0; i < 4; i++) h264.push(i ? delta() : idr(), Uint16Array.of(0, 0, 16, 16), main);
    const pictures = [env.decoders[0].emit(0), env.decoders[0].emit(1), env.decoders[0].emit(3)];
    h264.close();
    h264.close();
    assert.ok(pictures.every(picture => picture.closeCalls === 1));
    assert.equal(h264.stats().waiting, 0);
    assert.equal(h264.stats().backlog, 0);
    const late = env.decoders[0].emit(2);
    assert.equal(late.closeCalls, 1);
    if (rejected) reject(new Error("copy aborted"));
    else resolve(null);
    await settle();
    assert.deepEqual(combiner.calls, [["close"]]);
    assert.equal(h264.stats().compositing, 0);
    assert.deepEqual(env.draws, []);
  }
});

test("bounds surface operations queued behind missing decoder output", () => {
  const env = fakes();
  let exceeded = 0;
  const h264 = presenter(env, { onBacklogExceeded: () => { exceeded++; } });
  h264.push(idr(), Uint16Array.of(0, 0, 16, 16));
  for (let i = 0; i < 300; i++) h264.push(new Uint8Array(), new Uint16Array(), rdpH264View.surfaceCopy);
  assert.equal(exceeded, 1);
  assert.equal(env.decoders[0].state, "closed");
  assert.deepEqual(env.draws, []);
});

test("bounds retained payload bytes even with few queued pictures", () => {
  const env = fakes();
  let exceeded = 0;
  const h264 = presenter(env, { onBacklogExceeded: () => { exceeded++; } });
  // A region payload alone exceeds the shared byte bound; no frame is decoded.
  h264.push(idr(), new Uint16Array(8 * 1024 * 1024));
  assert.equal(exceeded, 1);
  assert.equal(env.decoders[0].chunks.length, 0);
  assert.equal(h264.stats().queuedBytes, 0);
});

test("a large encoded picture reports byte pressure before the picture watermark", () => {
  const env = fakes();
  const pressure = [];
  const h264 = presenter(env, { onPressure: behind => pressure.push(behind) });
  const data = new Uint8Array((1 << 20) + idr().length);
  data.set(idr());
  h264.push(data, Uint16Array.of(0, 0, 16, 16));
  assert.deepEqual(pressure, [true]);
  assert.equal(h264.stats().backlog, 1);
  env.decoders[0].emit(0);
  assert.deepEqual(pressure, [true, false]);
  assert.equal(h264.stats().queuedBytes, 0);
  h264.close();
});

test("without full color, draws an AVC444 main view and only decodes its auxiliary view", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 32, 16), main | auxiliaryFollows);
  h264.push(delta(), Uint16Array.of(0, 0, 64, 48), auxiliary);
  env.decoders[0].emit(0);
  const auxiliaryPicture = env.decoders[0].emit(1);
  assert.deepEqual(env.draws, [[0, 0, 32, 16, 0, 0, 32, 16]]);
  assert.equal(auxiliaryPicture.closed, true);
});

test("with full color, combines both views and paints once the auxiliary view is applied", async () => {
  const env = fakes();
  let fullColor = 0;
  const { h264, combiner } = fullColorPresenter(env, { onFullColor: () => { fullColor += 1; } });
  h264.push(idr(), Uint16Array.of(0, 0, 32, 16), main | v2 | auxiliaryFollows);
  h264.push(delta(), Uint16Array.of(8, 8, 8, 8), auxiliary | v2);
  const pictures = [env.decoders[0].emit(0), env.decoders[0].emit(1)];
  await settle();
  assert.deepEqual(combiner.calls, [
    ["main", 0, [[0, 0, 32, 16]]],
    ["auxiliary", 2, 1, [[8, 8, 8, 8]]],
    ["paint", [[0, 0, 32, 16], [8, 8, 8, 8]]],
  ]);
  assert.deepEqual(env.draws, [
    [0, 0, 32, 16, 0, 0, 32, 16],
    [8, 8, 8, 8, 8, 8, 8, 8],
  ]);
  assert.ok(env.sources.every((source) => source === combiner.canvas));
  assert.ok(pictures.every((picture) => picture.closed));
  assert.equal(fullColor, 1);
});

test("with full color, paints a luma-only main view at once and reports full color only after an auxiliary view", async () => {
  const env = fakes();
  let fullColor = 0;
  const { h264, combiner } = fullColorPresenter(env, { onFullColor: () => { fullColor += 1; } });
  h264.push(idr(), Uint16Array.of(0, 0, 16, 16), main);
  env.decoders[0].emit(0);
  await settle();
  assert.deepEqual(combiner.calls, [["main", 0, [[0, 0, 16, 16]]], ["paint", [[0, 0, 16, 16]]]]);
  assert.equal(fullColor, 0);
  h264.push(delta(), Uint16Array.of(0, 0, 100, 100), auxiliary);
  env.decoders[0].emit(1);
  await settle();
  // Painting is clipped to the combined picture.
  assert.deepEqual(combiner.calls.slice(2), [["auxiliary", 1, 1, [[0, 0, 100, 100]]], ["paint", [[0, 0, 64, 48]]]]);
  assert.equal(fullColor, 1);
});

test("with full color, draws AVC420 pictures directly and in order with combined ones", async () => {
  const env = fakes();
  const { h264 } = fullColorPresenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 16, 16), main);
  h264.push(delta(), Uint16Array.of(4, 4, 4, 4), rdpH264View.avc420);
  const avc420 = (env.decoders[0].emit(0), env.decoders[0].emit(1));
  await settle();
  assert.deepEqual(env.draws, [
    [0, 0, 16, 16, 0, 0, 16, 16],
    [4, 4, 4, 4, 4, 4, 4, 4],
  ]);
  assert.equal(env.sources[1], avc420);
});

test("with full color but frames it can't read, goes back to drawing main views", async () => {
  const env = fakes();
  const { h264, combiner } = fullColorPresenter(env, { readPlanes: async () => null });
  h264.push(idr(), Uint16Array.of(0, 0, 16, 16), main | auxiliaryFollows);
  h264.push(delta(), Uint16Array.of(0, 0, 16, 16), auxiliary);
  const [mainPicture] = [env.decoders[0].emit(0), env.decoders[0].emit(1)];
  await settle();
  assert.deepEqual(combiner.calls, [["close"]]);
  assert.deepEqual(env.draws, [[0, 0, 16, 16, 0, 0, 16, 16]]);
  assert.equal(env.sources[0], mainPicture);
  // Later pictures skip the combiner.
  h264.push(delta(), Uint16Array.of(0, 0, 8, 8), main);
  env.decoders[0].emit(2);
  assert.equal(env.draws.length, 2);
});

test("with full color but no WebGL2, draws main views", () => {
  const env = fakes();
  const h264 = presenter(env, { fullColor: true, createCombiner: () => null });
  h264.push(idr(), Uint16Array.of(0, 0, 16, 16), main | auxiliaryFollows);
  h264.push(delta(), Uint16Array.of(0, 0, 16, 16), auxiliary);
  env.decoders[0].emit(0);
  env.decoders[0].emit(1);
  return settle().then(() => assert.deepEqual(env.draws, [[0, 0, 16, 16, 0, 0, 16, 16]]));
});

test("closes the combiner on close and draws nothing still queued", async () => {
  const env = fakes();
  const { h264, combiner } = fullColorPresenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 16, 16), main);
  h264.push(delta(), Uint16Array.of(0, 0, 16, 16), main);
  env.decoders[0].emit(0);
  await settle();
  const picture = env.decoders[0].emit(1);
  h264.close();
  await settle();
  assert.equal(env.draws.length, 1);
  assert.equal(picture.closed, true);
  assert.deepEqual(combiner.calls.map(([call]) => call), ["main", "paint", "close"]);
});

test("remembers the full color choice, off by default", async () => {
  const { readRDPFullColorPreference, saveRDPFullColorPreference } = await import("./rdp-h264.mjs");
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readRDPFullColorPreference(storage), false);
  saveRDPFullColorPreference(storage, true);
  assert.equal(readRDPFullColorPreference(storage), true);
  saveRDPFullColorPreference(storage, false);
  assert.equal(readRDPFullColorPreference(storage), false);
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(readRDPFullColorPreference(broken), false);
  saveRDPFullColorPreference(broken, true);
  assert.equal(readRDPFullColorPreference(null), false);
});

const { surfaceOutput, surfaceCopy, surfacesReset } = rdpH264View;

test("a stalled AVC444 copy keeps auxiliary views and surface copies in order", async () => {
  const env = fakes();
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  let reads = 0;
  const { h264, combiner } = fullColorPresenter(env, {
    readPlanes: () => reads++ === 0 ? blocked : Promise.resolve({ id: 1, data: new Uint8Array(1) }),
  });
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 0, 0), surfaceOutput, 0);
  h264.push(idr(), Uint16Array.of(0, 0, 16, 16), main | auxiliaryFollows, 65532);
  h264.push(delta(), Uint16Array.of(0, 0, 16, 16), auxiliary, 65532);
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 16, 16, 4, 4, 0, 0), surfaceCopy, 65532);
  h264.push(new Uint8Array(), Uint16Array.of(10, 20, 0, 0), surfaceOutput, 0);
  env.decoders[0].emit(0);
  env.decoders[0].emit(1);
  await settle();
  assert.deepEqual(env.draws, []);
  assert.deepEqual(combiner.calls, []);
  unblock({ id: 0, data: new Uint8Array(1) });
  await settle();
  assert.deepEqual(combiner.calls.map(([call]) => call), ["main", "auxiliary", "paint"]);
  assert.deepEqual(env.draws[0], [0, 0, 16, 16, 4, 4, 16, 16], "copy applies before the mapping moves");
  assert.equal(h264.stats().backlog, 0);
  assert.equal(h264.stats().dropped, 0);
  h264.close();
});

// Canvases that record what is drawn onto them, by name.
function fakeCanvases() {
  const made = [];
  const createCanvas = (width, height) => {
    const draws = [];
    const surfaceCanvas = { name: `surface${made.length}`, width, height, draws, getContext: () => ({ drawImage: (source, ...args) => draws.push([source.name ?? "picture", ...args]) }) };
    made.push(surfaceCanvas);
    return surfaceCanvas;
  };
  return { made, createCanvas };
}

test("keeps pictures of a surface that isn't shown, and shows them when copied to one that is", () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const h264 = presenter(env, { createCanvas: canvases.createCanvas });
  // Remotr's AVC444 mode: surface 0 shown at 0,0; pictures go to 65532, which is copied over.
  h264.push(new Uint8Array(), new Uint16Array(), surfaceOutput, 65532);
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 0, 0), surfaceOutput, 0);
  h264.push(idr(), Uint16Array.of(0, 0, 64, 32), rdpH264View.avc420, 65532);
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 64, 32, 0, 0, 0, 0), surfaceCopy, 65532);
  env.decoders[0].emit(0);

  // Surface 0, the one shown, at 0,0, is kept in the pane's canvas: the copy
  // is drawn there once, and surface 0 has no canvas of its own.
  assert.equal(canvases.made.length, 1);
  const [hidden] = canvases.made;
  assert.deepEqual(hidden.draws, [["picture", 0, 0, 64, 32, 0, 0, 64, 32]]);
  assert.deepEqual(env.sources.map((source) => source.name), [hidden.name]);
  assert.deepEqual(env.draws, [[0, 0, 64, 32, 0, 0, 64, 32]]);
});

test("waits for a picture before applying a copy pushed after it", () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const h264 = presenter(env, { createCanvas: canvases.createCanvas });
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 0, 0), surfaceOutput, 0);
  h264.push(idr(), Uint16Array.of(0, 0, 16, 16), rdpH264View.avc420, 5);
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 16, 16, 4, 4, 0, 0), surfaceCopy, 5);
  assert.deepEqual(env.draws, []);
  env.decoders[0].emit(0);
  assert.deepEqual(env.draws, [[0, 0, 16, 16, 4, 4, 16, 16]]);
});

test("draws a shown surface at its origin, and stops showing it once it is gone", () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const h264 = presenter(env, { createCanvas: canvases.createCanvas });
  h264.push(new Uint8Array(), Uint16Array.of(100, 50, 0, 0), surfaceOutput, 3);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8), rdpH264View.avc420, 3);
  env.decoders[0].emit(0);
  assert.deepEqual(env.draws, [[0, 0, 8, 8, 100, 50, 8, 8]]);
  h264.push(new Uint8Array(), new Uint16Array(), surfaceOutput, 3);
  h264.push(delta(), Uint16Array.of(0, 0, 8, 8), rdpH264View.avc420, 3);
  env.decoders[0].emit(1);
  assert.equal(env.draws.length, 1);
});

test("shows a surface's pixels when it is mapped after pictures arrived", () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const h264 = presenter(env, { createCanvas: canvases.createCanvas });
  h264.push(new Uint8Array(), new Uint16Array(), surfacesReset, 0);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8), rdpH264View.avc420, 2);
  env.decoders[0].emit(0);
  assert.deepEqual(env.draws, []);
  h264.push(new Uint8Array(), Uint16Array.of(10, 20, 0, 0), surfaceOutput, 2);
  assert.deepEqual(env.draws, [[10, 20]]);
  assert.equal(env.sources[0], canvases.made[0]);
});

test("grows a surface's canvas and keeps what it held", () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const h264 = presenter(env, { createCanvas: canvases.createCanvas });
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8), rdpH264View.avc420, 0);
  h264.push(delta(), Uint16Array.of(0, 0, 32, 16), rdpH264View.avc420, 0);
  env.decoders[0].emit(0);
  env.decoders[0].emit(1);
  const [small, large] = canvases.made;
  assert.deepEqual([large.width, large.height], [32, 16]);
  assert.deepEqual(large.draws[0], [small.name, 0, 0]);
});

test("keeps surface operations when the decoder resets", () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const h264 = presenter(env, { createCanvas: canvases.createCanvas });
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8), rdpH264View.avc420, 1);
  h264.push(new Uint8Array(), Uint16Array.of(30, 40, 0, 0), surfaceOutput, 1);
  env.decoders[0].error(new Error("decode failed"));
  // The picture is gone, but surface 1 is now known to be shown at 30,40.
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8), rdpH264View.avc420, 1);
  env.decoders[1].emit(0);
  assert.deepEqual(env.draws, [[0, 0, 8, 8, 30, 40, 8, 8]]);
});

test("with full color, draws the combined picture to the update's surface", async () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const { h264, combiner } = fullColorPresenter(env, { createCanvas: canvases.createCanvas });
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 0, 0), surfaceOutput, 0);
  h264.push(idr(), Uint16Array.of(0, 0, 16, 16), main | v2 | auxiliaryFollows, 65532);
  h264.push(delta(), Uint16Array.of(0, 0, 16, 16), auxiliary | v2, 65532);
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 16, 16, 0, 0, 0, 0), surfaceCopy, 65532);
  env.decoders[0].emit(0);
  env.decoders[0].emit(1);
  await settle();
  // Surface 65532 is kept in the combiner's canvas, so the copy to the
  // pane's canvas, which holds surface 0, is the only draw.
  assert.equal(canvases.made.length, 0);
  assert.deepEqual(env.sources.map((source) => source.name), ["combined"]);
  assert.deepEqual(env.draws, [[0, 0, 16, 16, 0, 0, 16, 16]]);
  assert.equal(combiner.calls.at(-1)[0], "paint");
});

// Remotr's full color mode: surface 0 shown at 0,0, and an update combined
// for hidden surface 65532, then copied to surface 0.
async function combinedUpdate(env, h264, surfaceId = 65532, region = [0, 0, 16, 16], picture = 0) {
  h264.push(picture ? delta() : idr(), Uint16Array.of(...region), main | v2 | auxiliaryFollows, surfaceId);
  h264.push(delta(), Uint16Array.of(...region), auxiliary | v2, surfaceId);
  env.decoders[0].emit(picture);
  env.decoders[0].emit(picture + 1);
  await settle();
}

test("gives the surface kept in the combiner's canvas its own once something else draws to it", async () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const { h264 } = fullColorPresenter(env, { createCanvas: canvases.createCanvas });
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 0, 0), surfaceOutput, 0);
  await combinedUpdate(env, h264);
  assert.equal(canvases.made.length, 0);

  // A copy into it: it takes the combiner's pixels first.
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 8, 8, 4, 4, 65532, 0), surfaceCopy, 0);
  assert.equal(canvases.made.length, 1);
  const [own] = canvases.made;
  assert.deepEqual([own.width, own.height], [64, 48]);
  assert.deepEqual(own.draws, [["combined", 0, 0], ["pane", 0, 0, 8, 8, 4, 4, 8, 8]]);

  // Combined pictures for it are drawn to its own canvas from now on.
  await combinedUpdate(env, h264, 65532, [0, 0, 16, 16], 2);
  assert.deepEqual(own.draws.at(-1), ["combined", 0, 0, 16, 16, 0, 0, 16, 16]);
});

test("gives it its own once the combiner paints for another surface", async () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const { h264 } = fullColorPresenter(env, { createCanvas: canvases.createCanvas });
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 0, 0), surfaceOutput, 0);
  await combinedUpdate(env, h264);
  await combinedUpdate(env, h264, 7, [0, 0, 16, 16], 2);
  // 65532 took the combiner's pixels before the paint for surface 7, which
  // has a canvas of its own.
  const [hidden, other] = canvases.made;
  assert.deepEqual(hidden.draws, [["combined", 0, 0]]);
  assert.deepEqual(other.draws, [["combined", 0, 0, 16, 16, 0, 0, 16, 16]]);
});

test("gives it its own when a picture is drawn to it directly, or full color stops", async () => {
  for (const stop of ["picture", "give up"]) {
    const env = fakes();
    const canvases = fakeCanvases();
    const { h264, combiner } = fullColorPresenter(env, { createCanvas: canvases.createCanvas });
    h264.push(new Uint8Array(), Uint16Array.of(0, 0, 0, 0), surfaceOutput, 0);
    await combinedUpdate(env, h264);
    if (stop === "picture") {
      h264.push(delta(), Uint16Array.of(0, 0, 8, 8), rdpH264View.avc420, 65532);
      env.decoders[0].emit(2);
      await settle();
    } else {
      combiner.paint = () => {
        throw new Error("context lost");
      };
      await combinedUpdate(env, h264, 65532, [0, 0, 16, 16], 2);
    }
    // It takes the combiner's pixels first; a picture is then drawn to its
    // own canvas.
    const [own] = canvases.made;
    const expected = stop === "picture"
      ? [["combined", 0, 0], ["picture", 0, 0, 8, 8, 0, 0, 8, 8]]
      : [["combined", 0, 0]];
    assert.deepEqual(own.draws, expected, stop);
  }
});

test("keeps nothing in the combiner's canvas after every surface is gone", async () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const { h264 } = fullColorPresenter(env, { createCanvas: canvases.createCanvas });
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 0, 0), surfaceOutput, 0);
  await combinedUpdate(env, h264);
  h264.push(new Uint8Array(), new Uint16Array(), surfacesReset, 0);
  // A new surface the combiner paints for is kept in its canvas again.
  await combinedUpdate(env, h264, 3, [0, 0, 16, 16], 2);
  assert.equal(canvases.made.length, 0);
});

test("reports every drawn picture", () => {
  const env = fakes();
  let pictures = 0;
  const h264 = presenter(env, { onPicture: () => { pictures += 1; } });
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  h264.push(delta(), new Uint16Array());
  h264.push(delta(), Uint16Array.of(0, 0, 8, 8));
  env.decoders[0].emit(0);
  env.decoders[0].emit(1);
  env.decoders[0].emit(2);
  assert.equal(pictures, 2, "a picture without regions draws nothing");
});

test("draws a picture of the one surface shown at 0,0 once, on the pane's canvas", () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const h264 = presenter(env, { createCanvas: canvases.createCanvas });
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 0, 0), surfaceOutput, 0);
  h264.push(idr(), Uint16Array.of(0, 0, 32, 16), rdpH264View.avc420, 0);
  // A copy within the surface, as for scrolling, reads the pane's canvas.
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 32, 8, 0, 8, 0, 0), surfaceCopy, 0);
  env.decoders[0].emit(0);
  assert.equal(canvases.made.length, 0);
  assert.deepEqual(env.draws, [
    [0, 0, 32, 16, 0, 0, 32, 16],
    [0, 0, 32, 8, 0, 8, 32, 8],
  ]);
  assert.deepEqual(env.sources.map((source) => source.name ?? "picture"), ["picture", "pane"]);
});

test("gives the surface kept in the pane's canvas its own once another is shown or it moves", () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const h264 = presenter(env, { createCanvas: canvases.createCanvas });
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 0, 0), surfaceOutput, 0);
  h264.push(new Uint8Array(), Uint16Array.of(200, 100, 0, 0), surfaceOutput, 1);
  // Surface 0 takes the pane's pixels before surface 1 is shown over them.
  assert.equal(canvases.made.length, 1);
  const [own] = canvases.made;
  assert.deepEqual([own.width, own.height], [1024, 768]);
  assert.deepEqual(own.draws, [["pane", 0, 0]]);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8), rdpH264View.avc420, 0);
  env.decoders[0].emit(0);
  assert.deepEqual(own.draws.at(-1), ["picture", 0, 0, 8, 8, 0, 0, 8, 8]);
  assert.deepEqual(env.draws.at(-1), [0, 0, 8, 8, 0, 0, 8, 8]);

  // Once surface 1 is gone, surface 0 is kept in the pane's canvas again,
  // drawn there first.
  h264.push(new Uint8Array(), new Uint16Array(), surfaceOutput, 1);
  assert.deepEqual(env.sources.at(-1), own);
  assert.deepEqual(env.draws.at(-1), [0, 0]);
  h264.push(delta(), Uint16Array.of(0, 0, 8, 8), rdpH264View.avc420, 0);
  env.decoders[0].emit(1);
  assert.equal(own.draws.length, 2);
  assert.deepEqual(env.draws.at(-1), [0, 0, 8, 8, 0, 0, 8, 8]);

  // Moved away from 0,0, it gets a canvas of its own and is drawn where it is.
  h264.push(new Uint8Array(), Uint16Array.of(10, 10, 0, 0), surfaceOutput, 0);
  assert.equal(canvases.made.length, 2);
  assert.deepEqual(canvases.made[1].draws, [["pane", 0, 0]]);
  assert.deepEqual(env.draws.at(-1), [10, 10]);
});

test("gives a surface larger than the pane's canvas its own", () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const h264 = presenter(env, { createCanvas: canvases.createCanvas });
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 0, 0), surfaceOutput, 0);
  h264.push(idr(), Uint16Array.of(1000, 0, 48, 16), rdpH264View.avc420, 0);
  env.decoders[0].emit(0);
  // It takes the pane's pixels, then grows.
  const [taken, own] = canvases.made;
  assert.deepEqual(taken.draws, [["pane", 0, 0]]);
  assert.deepEqual([own.width, own.height], [1048, 768]);
  assert.deepEqual(own.draws[0], [taken.name, 0, 0]);
  assert.deepEqual(own.draws.at(-1), ["picture", 1000, 0, 48, 16, 1000, 0, 48, 16]);
  assert.deepEqual(env.draws.at(-1), [1000, 0, 48, 16, 1000, 0, 48, 16]);
});

test("after every surface is gone, keeps nothing in the pane's canvas", () => {
  const env = fakes();
  const canvases = fakeCanvases();
  const h264 = presenter(env, { createCanvas: canvases.createCanvas });
  h264.push(new Uint8Array(), Uint16Array.of(0, 0, 0, 0), surfaceOutput, 0);
  h264.push(new Uint8Array(), new Uint16Array(), surfacesReset, 0);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8), rdpH264View.avc420, 0);
  env.decoders[0].emit(0);
  // Surface 0 isn't shown now: its picture goes to a canvas of its own only.
  assert.equal(canvases.made.length, 1);
  assert.deepEqual(env.draws, []);
});

test("counts and times pictures for the stats overlay", () => {
  const env = fakes();
  let clock = 0;
  const h264 = presenter(env, { now: () => clock });
  h264.push(delta(), Uint16Array.of(0, 0, 8, 8));
  const key = idr();
  h264.push(key, Uint16Array.of(0, 0, 8, 8));
  clock = 5;
  env.decoders[0].emit(0);
  let reading = h264.stats();
  assert.equal(reading.pictures, 2);
  assert.equal(reading.bytes, delta().byteLength + key.byteLength);
  assert.equal(reading.dropped, 1, "the delta before the key frame");
  assert.equal(reading.decoded, 1);
  assert.equal(reading.presented, 1);
  assert.equal(reading.decodeMs, 5);
  assert.equal(reading.decodeMaxMs, 5);
  assert.equal(reading.latencyMaxMs, 5);
  assert.equal(reading.decodeQueue, 0);
  reading = h264.stats();
  assert.equal(reading.decodeMaxMs, 0, "maxima are since the last reading");
  assert.equal(reading.latencyMaxMs, 0);
  assert.equal(reading.decodeMs, 5, "totals keep counting");

  env.decoders[0].error(new Error("decode failed"));
  assert.equal(h264.stats().errors, 1);
});
