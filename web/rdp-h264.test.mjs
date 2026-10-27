import assert from "node:assert/strict";
import test from "node:test";

import { createRDPH264Presenter, rdpH264ProbeCodec, rdpH264Supported } from "./rdp-h264.mjs";

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
    getContext: () => ({ drawImage: (picture, ...args) => draws.push(args) }),
  };
  return { decoders, draws, canvas, VideoDecoder: FakeVideoDecoder, EncodedVideoChunk: FakeEncodedVideoChunk };
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

test("matches pictures to their regions by timestamp", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  h264.push(delta(), Uint16Array.of(8, 8, 4, 4));
  const decoder = env.decoders[0];
  assert.deepEqual(decoder.chunks.map((chunk) => chunk.type), ["key", "delta"]);
  decoder.emit(1);
  decoder.emit(0);
  assert.deepEqual(env.draws, [
    [8, 8, 4, 4, 8, 8, 4, 4],
    [0, 0, 8, 8, 0, 0, 8, 8],
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

test("forgets the oldest pending pictures when the decoder never outputs them", () => {
  const env = fakes();
  const h264 = presenter(env);
  h264.push(idr(), Uint16Array.of(0, 0, 8, 8));
  for (let i = 0; i < 100; i += 1) h264.push(delta(), Uint16Array.of(0, 0, 8, 8));
  env.decoders[0].emit(0);
  assert.deepEqual(env.draws, []);
  env.decoders[0].emit(100);
  assert.equal(env.draws.length, 1);
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
