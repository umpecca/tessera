import test from "node:test";
import assert from "node:assert/strict";
import { TerminalRenderScheduler } from "./terminal-render-scheduler.mjs";

for (const hz of [30, 60, 120]) {
  test(`30 FPS stays steady with jitter at ${hz} Hz`, () => {
    let now = 0;
    let callback;
    let paints = 0;
    const scheduler = new TerminalRenderScheduler({
      now: () => now,
      requestFrame: fn => { callback = fn; return 1; }, cancelFrame() {},
    });
    const terminal = { paintFPSLimit: 30 };
    scheduler.register(terminal, () => { paints++; now += 4; });
    scheduler.setContinuous(terminal, true);
    for (let i = 0; i < hz * 10; i++) {
      const timestamp = i * 1000 / hz + (i % 2 ? -0.3 : 0.3);
      now = timestamp + (i % 3) * 2;
      callback(timestamp);
    }
    assert.ok(paints >= 299 && paints <= 301, `${paints} paints in ten seconds`);
    const before = paints;
    now = 60000;
    callback(now);
    assert.equal(paints, before + 1);
    now += 5;
    callback(now);
    assert.equal(paints, before + 1, "no catch-up burst after idle");
    scheduler.setPaused(terminal, true);
    scheduler.setPaused(terminal, false);
    callback(now);
    assert.equal(paints, before + 2, "exposure paints immediately");
  });
}

test("caps output frames, preserves pending output, and allows input to bypass the cap", () => {
  let now = 0;
  let callback;
  let paints = 0;
  const scheduler = new TerminalRenderScheduler({
    now: () => now,
    requestFrame: fn => { callback = fn; return 1; },
    cancelFrame: () => { callback = null; },
  });
  const terminal = { paintFPSLimit: 30 };
  scheduler.register(terminal, () => { paints++; now += 2; });
  scheduler.setMetricsEnabled(terminal, true);
  callback();
  now = 16;
  scheduler.request(terminal);
  callback();
  assert.equal(paints, 1);
  assert.equal(scheduler.pending.has(terminal), true);
  now = 34;
  callback();
  assert.equal(paints, 2);
  now = 40;
  terminal.interactivePaintUntil = 190;
  scheduler.request(terminal);
  callback();
  assert.equal(paints, 3);
  assert.deepEqual(scheduler.statistics(terminal), {
    frames: 3, averageMs: 2, maxMs: 2, totalMs: 6,
    recent: { fps: 0.6, averageMs: 2, maxMs: 2, paintMsPerSecond: 1.2 },
  });
  now = 5043;
  assert.deepEqual(scheduler.statistics(terminal).recent,
    { fps: 0, averageMs: 0, maxMs: 0, paintMsPerSecond: 0 });
  assert.equal(scheduler.statistics(terminal).frames, 3);
  scheduler.setPaused(terminal, true);
  scheduler.request(terminal);
  assert.equal(scheduler.pending.size, 0);
});
