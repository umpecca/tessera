import assert from "node:assert/strict";
import test from "node:test";

import {
  PrimaryDeviceAttributesQueryParser,
  primaryDeviceAttributesResponse,
} from "./terminal-device-attributes.mjs";

test("uses the conservative VT100-family response with no optional hardware", () => {
  assert.equal(primaryDeviceAttributesResponse, "\x1b[?1;0c");
});

test("recognizes omitted and zero DA1 parameters", () => {
  const parser = new PrimaryDeviceAttributesQueryParser();
  assert.deepEqual(parser.write("before\x1b[c between\x1b[0c after"), [9, 21]);
});

test("recognizes binary DA1 requests", () => {
  const parser = new PrimaryDeviceAttributesQueryParser();
  assert.deepEqual(parser.write(Uint8Array.from([0x1b, 0x5b, 0x30, 0x63])), [4]);
});

test("recognizes a request split at every write boundary", () => {
  const parser = new PrimaryDeviceAttributesQueryParser();
  assert.deepEqual(parser.write("\x1b"), []);
  assert.deepEqual(parser.write("["), []);
  assert.deepEqual(parser.write("0"), []);
  assert.deepEqual(parser.write("c"), [1]);
});

test("ignores secondary, tertiary, parameterized, and false prefixes", () => {
  const parser = new PrimaryDeviceAttributesQueryParser();
  const data = [
    "\x1b[>c",
    "\x1b[=c",
    "\x1b[1c",
    "\x1b[00c",
    "text[c",
    "\x1bXc",
  ].join("");
  assert.deepEqual(parser.write(data), []);
});

test("recovers when a new escape interrupts a false prefix", () => {
  const parser = new PrimaryDeviceAttributesQueryParser();
  assert.deepEqual(parser.write("\x1b[>\x1b[0c"), [7]);
});

test("reset discards a partial request from a superseded stream", () => {
  const parser = new PrimaryDeviceAttributesQueryParser();
  assert.deepEqual(parser.write("\x1b[0"), []);
  parser.reset();
  assert.deepEqual(parser.write("c"), []);
  assert.deepEqual(parser.write("\x1b[0c"), [4]);
});
