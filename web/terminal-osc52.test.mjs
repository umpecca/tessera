import assert from "node:assert/strict";
import test from "node:test";

import { TerminalOSC52Filter } from "./terminal-osc52.mjs";

const encoder = new TextEncoder();

function base64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function writeString(filter, chunk) {
  const result = filter.write(chunk);
  return { data: result.data === null ? "" : result.data, clipboard: result.clipboard };
}

function writeBytes(filter, chunk) {
  const result = filter.write(encoder.encode(chunk));
  return {
    data: result.data === null ? "" : new TextDecoder().decode(result.data),
    clipboard: result.clipboard,
  };
}

test("ordinary output passes through untouched", () => {
  const filter = new TerminalOSC52Filter();
  const written = writeString(filter, "plain \x1b[31mred\x1b[0m text\r\n");
  assert.equal(written.data, "plain \x1b[31mred\x1b[0m text\r\n");
  assert.deepEqual(written.clipboard, []);
});

test("a BEL-terminated OSC 52 write is lifted out of the stream", () => {
  const filter = new TerminalOSC52Filter();
  const written = writeString(filter, `before\x1b]52;c;${base64("copied from a TUI")}\x07after`);
  assert.equal(written.data, "beforeafter");
  assert.deepEqual(written.clipboard, ["copied from a TUI"]);
});

test("the ESC-backslash string terminator is accepted", () => {
  const filter = new TerminalOSC52Filter();
  const written = writeString(filter, `\x1b]52;c;${base64("terminated with ST")}\x1b\\tail`);
  assert.equal(written.data, "tail");
  assert.deepEqual(written.clipboard, ["terminated with ST"]);
});

test("clipboard text keeps its UTF-8 and newlines", () => {
  const filter = new TerminalOSC52Filter();
  const written = writeString(filter, `\x1b]52;c;${base64("héllo ✂\nsecond line")}\x07`);
  assert.equal(written.data, "");
  assert.deepEqual(written.clipboard, ["héllo ✂\nsecond line"]);
});

test("binary chunks stay binary", () => {
  const filter = new TerminalOSC52Filter();
  const written = writeBytes(filter, `left\x1b]52;c;${base64("bytes")}\x07right`);
  assert.equal(written.data, "leftright");
  assert.deepEqual(written.clipboard, ["bytes"]);
});

test("a sequence split across frames is still recognized", () => {
  const filter = new TerminalOSC52Filter();
  const encoded = base64("split across frames");
  const first = writeString(filter, `head\x1b]5`);
  const second = writeString(filter, `2;c;${encoded.slice(0, 3)}`);
  const third = writeString(filter, `${encoded.slice(3)}\x07tail`);
  assert.equal(first.data, "head");
  assert.equal(second.data, "");
  assert.equal(third.data, "tail");
  assert.deepEqual([...first.clipboard, ...second.clipboard, ...third.clipboard], ["split across frames"]);
});

test("an escape that only looks like OSC 52 is replayed in order", () => {
  const filter = new TerminalOSC52Filter();
  const written = writeString(filter, "\x1b]0;window title\x07body");
  assert.equal(written.data, "\x1b]0;window title\x07body");
  assert.deepEqual(written.clipboard, []);

  const split = new TerminalOSC52Filter();
  const first = writeString(split, "\x1b]5");
  const second = writeString(split, "3;x\x07");
  assert.equal(first.data, "");
  assert.equal(`${first.data}${second.data}`, "\x1b]53;x\x07");
});

test("a lone escape or introducer is replayed rather than swallowed", () => {
  const filter = new TerminalOSC52Filter();
  const written = writeString(filter, "\x1b[Ktext\x1b");
  assert.equal(written.data, "\x1b[Ktext");
  assert.equal(writeString(filter, "]11;?\x07").data, "\x1b]11;?\x07");
});

// A candidate that starts inside a chunk is replayed by pointing back at the
// bytes; one that arrives split has to carry them. These walk the split
// through every position of a sequence that turns out not to be OSC 52, since
// each one hands over at a different point in the parse.
test("a non-OSC-52 sequence survives a split at any byte", () => {
  const sequence = "\x1b]11;rgb:0f0f/0f0f/0f0f\x07";
  for (let split = 1; split < sequence.length; split += 1) {
    const filter = new TerminalOSC52Filter();
    const first = writeString(filter, `head${sequence.slice(0, split)}`);
    const second = writeString(filter, `${sequence.slice(split)}tail`);
    assert.equal(
      `${first.data}${second.data}`,
      `head${sequence}tail`,
      `split after ${split} byte(s) lost or reordered output`,
    );
    assert.deepEqual([...first.clipboard, ...second.clipboard], []);
  }
});

test("an OSC 52 write survives a split at any byte", () => {
  const sequence = `\x1b]52;c;${base64("carried")}\x07`;
  for (let split = 1; split < sequence.length; split += 1) {
    const filter = new TerminalOSC52Filter();
    const first = writeString(filter, `head${sequence.slice(0, split)}`);
    const second = writeString(filter, `${sequence.slice(split)}tail`);
    assert.equal(`${first.data}${second.data}`, "headtail", `split after ${split} byte(s) leaked`);
    assert.deepEqual([...first.clipboard, ...second.clipboard], ["carried"], `split after ${split}`);
  }
});

test("a split candidate carries its bytes across binary frames too", () => {
  const filter = new TerminalOSC52Filter();
  const first = writeBytes(filter, "before\x1b]5");
  const second = writeBytes(filter, "1;not us\x07after");
  assert.equal(first.data, "before");
  assert.equal(second.data, "\x1b]51;not us\x07after");
  assert.deepEqual([...first.clipboard, ...second.clipboard], []);
});

// The scan skips ahead to the next escape; a chunk with none at all must
// still come back whole.
test("a chunk with no escapes passes through in one piece", () => {
  const filter = new TerminalOSC52Filter();
  const plain = "no escapes here, just ordinary output\r\n".repeat(64);
  assert.equal(writeString(filter, plain).data, plain);
  assert.equal(writeBytes(filter, plain).data, plain);
});

test("an escape as the final byte of a chunk is held, not dropped", () => {
  const filter = new TerminalOSC52Filter();
  assert.equal(writeString(filter, "text\x1b").data, "text");
  assert.equal(writeString(filter, "[0mmore").data, "\x1b[0mmore");
});

test("every OSC 52 target writes to the one system clipboard", () => {
  const filter = new TerminalOSC52Filter();
  const written = writeString(
    filter,
    `\x1b]52;p;${base64("primary")}\x07\x1b]52;s0;${base64("selection")}\x07`,
  );
  assert.equal(written.data, "");
  assert.deepEqual(written.clipboard, ["primary", "selection"]);
});

test("a clipboard read request is swallowed and never answered", () => {
  const filter = new TerminalOSC52Filter();
  const written = writeString(filter, "before\x1b]52;c;?\x07after");
  assert.equal(written.data, "beforeafter");
  assert.deepEqual(written.clipboard, []);
});

test("an empty payload clears nothing and copies nothing", () => {
  const filter = new TerminalOSC52Filter();
  const written = writeString(filter, "a\x1b]52;c;\x07b");
  assert.equal(written.data, "ab");
  assert.deepEqual(written.clipboard, []);
});

test("unpadded base64 is decoded and mangled base64 is dropped", () => {
  const filter = new TerminalOSC52Filter();
  const unpadded = writeString(filter, `\x1b]52;c;${base64("pad").replace(/=+$/, "")}\x07`);
  assert.deepEqual(unpadded.clipboard, ["pad"]);
  const mangled = writeString(filter, `\x1b]52;c;not valid base64!!\x07keep`);
  assert.equal(mangled.data, "keep");
  assert.deepEqual(mangled.clipboard, []);
});

test("an oversized payload is consumed without copying anything", () => {
  const filter = new TerminalOSC52Filter(16);
  const written = writeString(filter, `\x1b]52;c;${base64("far beyond the cap")}\x07visible`);
  assert.equal(written.data, "visible");
  assert.deepEqual(written.clipboard, []);
});

test("an unterminated sequence releases the escape that interrupted it", () => {
  const filter = new TerminalOSC52Filter();
  const written = writeString(filter, `\x1b]52;c;${base64("interrupted")}\x1b[0mrest`);
  assert.equal(written.data, "\x1b[0mrest");
  assert.deepEqual(written.clipboard, ["interrupted"]);
});

test("back-to-back sequences are each copied", () => {
  const filter = new TerminalOSC52Filter();
  const written = writeString(
    filter,
    `\x1b]52;c;${base64("first")}\x1b\\middle\x1b]52;c;${base64("second")}\x07`,
  );
  assert.equal(written.data, "middle");
  assert.deepEqual(written.clipboard, ["first", "second"]);
});
