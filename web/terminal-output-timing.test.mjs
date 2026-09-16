import assert from "node:assert/strict";
import test from "node:test";

import { TerminalOutputTiming, formatOutputTiming, synchronizedUpdateMarkers } from "./terminal-output-timing.mjs";

const bytes = (text) => new TextEncoder().encode(text);

test("finds synchronized update markers in order", () => {
  assert.deepEqual(synchronizedUpdateMarkers(bytes("\x1b[?2026hframe\x1b[?2026l\x1b[?2026h")), [true, false, true]);
  assert.deepEqual(synchronizedUpdateMarkers(bytes("\x1b[?2025h\x1b[?2026")), []);
});

test("follows events from host read to paint without comparing clocks", () => {
  let clock = 1000;
  const timing = new TerminalOutputTiming(() => clock);
  for (let index = 0; index < 3; index++) {
    const sequence = index + 1;
    const hostRead = 50_000 + index * 50;
    clock = 1000 + index * 50 + (index === 2 ? 30 : 0);
    timing.received(sequence, bytes("\x1b[?2026hx\x1b[?2026l"));
    timing.host({ sequence, readUs: hostRead * 1000, queuedUs: (hostRead + 1) * 1000, sentUs: (hostRead + 2) * 1000 });
    clock += 2;
    timing.applied(sequence);
    clock += 8;
    timing.painted();
  }
  timing.stop();
  clock += 60_000;
  const summary = timing.summary();
  assert.equal(summary.seconds, 0.14);
  assert.equal(summary.events, 3);
  assert.deepEqual(summary.intervals.hostRead, { count: 2, p50: 50, p95: 50, max: 50 });
  assert.equal(summary.intervals.received.max, 80);
  assert.equal(summary.latency.hostParse.p50, 1);
  assert.equal(summary.latency.hostSend.p50, 1);
  assert.equal(summary.latency.transitJitter.max, 30);
  assert.equal(summary.latency.paintWait.p50, 8);
  assert.deepEqual(summary.synchronizedUpdates, { blocks: 3, split: 0, maxMessages: 1, paintsDuring: 0 });
  assert.match(formatOutputTiming(summary), /network jitter 0\.0\/30\.0\/30\.0/);
});

test("groups PTY reads of one frame and reports frames painted in pieces", () => {
  let clock = 0;
  const timing = new TerminalOutputTiming(() => clock);
  const frame = (sequence, readMs, size) => {
    timing.received(sequence, new Uint8Array(size));
    timing.host({ sequence, readUs: readMs * 1000, queuedUs: readMs * 1000, sentUs: readMs * 1000 });
    timing.applied(sequence);
  };
  frame(1, 0, 8192);
  frame(2, 1, 4000);
  clock = 5;
  timing.painted();
  clock = 90;
  frame(3, 90, 8192);
  clock = 95;
  timing.painted();
  frame(4, 91, 4000);
  clock = 100;
  timing.painted();
  const bursts = timing.summary().bursts;
  assert.equal(bursts.count, 2);
  assert.equal(bursts.split, 2);
  assert.equal(bursts.maxEvents, 2);
  assert.equal(bursts.paintedInPieces, 1);
  assert.deepEqual(bursts.bytes, { count: 2, p50: 12192, p95: 12192, max: 12192 });
});

test("reports frames split across messages and painted before completion", () => {
  let clock = 0;
  const timing = new TerminalOutputTiming(() => clock);
  timing.received(1, bytes("\x1b[?2026hhalf"));
  timing.applied(1);
  clock = 16;
  timing.painted();
  timing.received(2, bytes("rest\x1b[?2026l"));
  clock = 20;
  timing.applied(2);
  timing.painted();
  assert.deepEqual(timing.summary().synchronizedUpdates, { blocks: 1, split: 1, maxMessages: 2, paintsDuring: 1 });
});
