import assert from "node:assert/strict";
import test from "node:test";

import {
  annexBNals,
  escapeRbsp,
  h264CodecString,
  lowDelaySps,
  unescapeRbsp,
  withLowDelaySps,
} from "./rdp-h264-sps.mjs";

const hex = (value) => Uint8Array.from(value.match(/../g).map((byte) => Number.parseInt(byte, 16)));
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

// SPS NAL units from x264 streams and their rewrites. ffmpeg's trace_headers
// read max_num_reorder_frames = 0 in each rewrite, and every stream decoded to
// the same frames before and after.
const fixtures = {
  "VUI with restriction, POC type 2": ["67640020acb200980a360220000003002000000781e30649", "67640020acb200980a360220000003002000000781b4100849"],
  "no VUI, POC type 2": ["67640020acb200980a32", "67640020acb200980a340368201092"],
  "VUI with restriction, POC type 0": ["67640020acd9404c051b0110000003001000000303c0f1831960", "67640020acd9404c051b0110000003001000000303c0da08042580"],
  "no VUI, POC type 0": ["67640020acd9404c0519", "67640020acd9404c051a01b410084b"],
  "intra-only (no reference frames)": ["67641020acb80980a360220000030002000003007808", "67641020acb80980a36022000003000200000300781b41008540"],
  "intra-only without VUI": ["67641020acb80980a320", "67641020acb80980a3403682010a80"],
};

for (const [name, [input, output]] of Object.entries(fixtures)) {
  test(`declares no reordering in an SPS: ${name}`, () => {
    assert.equal(toHex(lowDelaySps(hex(input))), output);
  });
}

test("rewrites an already low-delay SPS to itself", () => {
  for (const [, output] of Object.values(fixtures)) {
    assert.equal(toHex(lowDelaySps(hex(output))), output);
  }
});

test("replaces only the SPS in an access unit", () => {
  const [input, output] = fixtures["no VUI, POC type 0"];
  const aud = "0000000109f0";
  const pps = "0000000168ebe3cb22c0";
  const slice = "0000016588840033ff";
  const unit = hex(`${aud}00000001${input}${pps}${slice}`);
  assert.equal(toHex(withLowDelaySps(unit)), `${aud}00000001${output}${pps}${slice}`);
});

test("leaves an access unit without an SPS untouched", () => {
  const unit = hex("0000000165888400");
  assert.equal(withLowDelaySps(unit), unit);
});

test("reuses a cached rewrite", () => {
  const [input, output] = fixtures["no VUI, POC type 2"];
  const cache = new Map();
  withLowDelaySps(hex(`00000001${input}`), cache);
  assert.equal(cache.size, 1);
  assert.equal(toHex(withLowDelaySps(hex(`00000001${input}`), cache)), `00000001${output}`);
  assert.equal(cache.size, 1);
});

test("escapes and unescapes emulation prevention bytes", () => {
  const raw = hex("000000000001000002000003ff0000");
  const escaped = escapeRbsp(raw);
  assert.equal(toHex(escaped), "00000300000300010000030200000303ff0000");
  assert.equal(toHex(unescapeRbsp(escaped)), toHex(raw));
  // A real 03 that follows an escape stays.
  assert.equal(toHex(unescapeRbsp(hex("0000030300"))), "00000300");
});

test("finds NAL units with three- and four-byte start codes", () => {
  const unit = hex("0000000109f000000167640020000001680000");
  assert.deepEqual(annexBNals(unit).map(({ type, start, end }) => ({ type, start, end })), [
    { type: 9, start: 4, end: 6 },
    { type: 7, start: 9, end: 13 },
    { type: 8, start: 16, end: 17 },
  ]);
});

test("reads the codec string from the SPS", () => {
  assert.equal(h264CodecString(hex(`0000000109f000000001${fixtures["no VUI, POC type 2"][0]}`)), "avc1.640020");
  assert.equal(h264CodecString(hex("0000000165888400")), "");
});
