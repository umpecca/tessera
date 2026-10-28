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
      const picture = { timestamp: this.chunks[index].timestamp, closed: false, close() { this.closed = true; } };
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

test("gives up a picture the decoder never outputs once later ones pile up", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  for (let i = 0; i < 20; i += 1) h264.push(delta(), Uint16Array.of(0, 0, 8, 8));
  for (let i = 1; i <= 8; i += 1) env.decoders[0].emit(i);
  assert.deepEqual(env.draws, []);
  env.decoders[0].emit(9);
  assert.equal(env.draws.length, 9);
});

test("forgets the oldest pictures when the decoder never outputs them", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  for (let i = 0; i < 100; i += 1) h264.push(delta(), Uint16Array.of(0, 0, 8, 8));
  const forgotten = env.decoders[0].emit(0);
  assert.equal(forgotten.closed, true);
  assert.deepEqual(env.draws, []);
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

  assert.equal(canvases.made.length, 2);
  const [hidden, shown] = canvases.made;
  assert.deepEqual(hidden.draws, [["picture", 0, 0, 64, 32, 0, 0, 64, 32]]);
  assert.deepEqual(shown.draws, [[hidden.name, 0, 0, 64, 32, 0, 0, 64, 32]]);
  // On the pane's canvas only the copy, from surface 0's canvas.
  assert.deepEqual(env.sources.map((source) => source.name), [shown.name]);
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
  assert.deepEqual(env.draws, [[4, 4, 16, 16, 4, 4, 16, 16]]);
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
  const [hidden, shown] = canvases.made;
  assert.deepEqual(hidden.draws, [["combined", 0, 0, 16, 16, 0, 0, 16, 16]]);
  assert.deepEqual(shown.draws, [[hidden.name, 0, 0, 16, 16, 0, 0, 16, 16]]);
  assert.deepEqual(env.draws, [[0, 0, 16, 16, 0, 0, 16, 16]]);
  assert.equal(combiner.calls.at(-1)[0], "paint");
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
