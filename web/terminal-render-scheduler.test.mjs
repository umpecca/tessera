import assert from "node:assert/strict";
import test from "node:test";

import { TerminalRenderScheduler } from "./terminal-render-scheduler.mjs";

function testScheduler(options = {}) {
  let nextFrameID = 1;
  const frames = new Map();
  const canceled = [];
  const scheduler = new TerminalRenderScheduler({
    requestFrame(callback) {
      const frameID = nextFrameID;
      nextFrameID += 1;
      frames.set(frameID, callback);
      return frameID;
    },
    cancelFrame(frameID) {
      canceled.push(frameID);
      frames.delete(frameID);
    },
    now: () => 0,
    ...options,
  });
  return {
    canceled,
    flushFrame() {
      const next = frames.entries().next().value;
      assert.ok(next, "expected a scheduled animation frame");
      const [frameID, callback] = next;
      frames.delete(frameID);
      callback();
    },
    frames,
    scheduler,
  };
}

test("coalesces requested terminals into one shared frame", () => {
  const { flushFrame, frames, scheduler } = testScheduler();
  const renders = [];
  const first = {};
  const second = {};

  scheduler.register(first, () => renders.push("first"));
  scheduler.register(second, () => renders.push("second"));
  scheduler.request(first);

  assert.equal(frames.size, 1);
  flushFrame();
  assert.deepEqual(renders, ["first", "second"]);
  assert.equal(frames.size, 0);
});

test("keeps only continuous terminals on subsequent frames", () => {
  const { flushFrame, frames, scheduler } = testScheduler();
  let activeRenders = 0;
  let inactiveRenders = 0;
  const active = {};
  const inactive = {};

  scheduler.register(active, () => activeRenders += 1);
  scheduler.register(inactive, () => inactiveRenders += 1);
  scheduler.setContinuous(active, true);

  flushFrame();
  assert.equal(activeRenders, 1);
  assert.equal(inactiveRenders, 1);
  assert.equal(frames.size, 1);

  flushFrame();
  assert.equal(activeRenders, 2);
  assert.equal(inactiveRenders, 1);
});

test("suppresses paused terminals and redraws once when restored", () => {
  const { flushFrame, frames, scheduler } = testScheduler();
  let renders = 0;
  const terminal = {};

  scheduler.register(terminal, () => renders += 1);
  scheduler.setPaused(terminal, true);
  scheduler.request(terminal);
  assert.equal(frames.size, 0);

  scheduler.setPaused(terminal, false);
  assert.equal(frames.size, 1);
  flushFrame();
  assert.equal(renders, 1);
  assert.equal(frames.size, 0);
});

test("document visibility cancels frames and redraws visible terminals", () => {
  const { canceled, flushFrame, frames, scheduler } = testScheduler();
  let firstRenders = 0;
  let pausedRenders = 0;
  const first = {};
  const paused = {};

  scheduler.register(first, () => firstRenders += 1);
  scheduler.register(paused, () => pausedRenders += 1);
  scheduler.setPaused(paused, true);
  scheduler.setEnabled(false);

  assert.equal(canceled.length, 1);
  assert.equal(frames.size, 0);
  scheduler.request(first);
  assert.equal(frames.size, 0);

  scheduler.setEnabled(true);
  flushFrame();
  assert.equal(firstRenders, 1);
  assert.equal(pausedRenders, 0);
});

test("unregister removes terminal work and cancels an idle frame", () => {
  const { canceled, frames, scheduler } = testScheduler();
  const terminal = {};

  scheduler.register(terminal, () => {});
  assert.equal(frames.size, 1);
  scheduler.unregister(terminal);

  assert.equal(frames.size, 0);
  assert.equal(canceled.length, 1);
});

test("standard rendering avoids timing work until metrics are requested", () => {
  let callback;
  let clockReads = 0;
  const scheduler = new TerminalRenderScheduler({
    now() { clockReads++; return 10; },
    requestFrame(fn) { callback = fn; return 1; },
    cancelFrame() {},
  });
  const terminal = { paintFPSLimit: 0 };
  scheduler.register(terminal, () => {});
  callback(0);
  assert.equal(clockReads, 0);
  assert.equal(scheduler.statistics(terminal).frames, 0);

  scheduler.setMetricsEnabled(terminal, true);
  scheduler.request(terminal);
  callback(16);
  assert.ok(clockReads >= 2);
  assert.equal(scheduler.statistics(terminal).frames, 1);
});

function coalescingScheduler() {
  let clock = 0;
  const frames = [];
  const scheduler = new TerminalRenderScheduler({
    requestFrame(callback) { frames.push(callback); return frames.length; },
    cancelFrame() {},
    now: () => clock,
  });
  return {
    scheduler,
    advance(ms) { clock += ms; },
    flushFrame() { const callback = frames.shift(); assert.ok(callback, "expected a frame"); callback(clock); },
  };
}

test("paint coalescing waits for output to go quiet before painting", () => {
  const { scheduler, advance, flushFrame } = coalescingScheduler();
  const terminal = { paintCoalescing: true };
  let renders = 0;
  scheduler.register(terminal, () => { renders++; });
  flushFrame();
  assert.equal(renders, 1);

  scheduler.noteOutput(terminal);
  advance(1);
  scheduler.noteOutput(terminal);
  advance(1);
  flushFrame();
  assert.equal(renders, 1, "output arrived within the quiet window");
  advance(3);
  flushFrame();
  assert.equal(renders, 2, "paints once output has been quiet");
});

test("paint coalescing never holds continuous output past the cap", () => {
  const { scheduler, advance, flushFrame } = coalescingScheduler();
  const terminal = { paintCoalescing: true };
  let renders = 0;
  scheduler.register(terminal, () => { renders++; });
  flushFrame();
  for (let elapsed = 0; elapsed < 14; elapsed += 2) {
    scheduler.noteOutput(terminal);
    advance(2);
    flushFrame();
  }
  assert.equal(renders, 1);
  scheduler.noteOutput(terminal);
  advance(2);
  flushFrame();
  assert.equal(renders, 2);
});

test("paint coalescing is bypassed while typing and when disabled", () => {
  const { scheduler, flushFrame } = coalescingScheduler();
  const typing = { paintCoalescing: true, interactivePaintUntil: 100 };
  const disabled = { paintCoalescing: false };
  let renders = 0;
  scheduler.register(typing, () => { renders++; });
  scheduler.register(disabled, () => { renders++; });
  flushFrame();
  scheduler.noteOutput(typing);
  scheduler.noteOutput(disabled);
  flushFrame();
  assert.equal(renders, 4);
});

test("ready panes share a 6 ms painting budget and unpainted requests survive", () => {
  let now = 0;
  const { scheduler, flushFrame, frames } = testScheduler({ now: () => now });
  const paints = [];
  const panes = ["A", "B", "C", "D"].map(name => ({ name }));
  for (const pane of panes) scheduler.register(pane, () => { paints.push(pane.name); now += 2; });
  flushFrame();
  assert.deepEqual(paints, ["A", "B", "C"]);
  assert.equal(now, 6);
  assert.equal(scheduler.pending.has(panes[3]), true);
  assert.equal(frames.size, 1);
  flushFrame();
  assert.deepEqual(paints, ["A", "B", "C", "D"]);
  assert.equal(frames.size, 0);
});

test("the active pane paints first while deferred background work rotates ahead of continuous output", () => {
  let now = 0;
  const { scheduler, flushFrame } = testScheduler({ now: () => now });
  const paints = [], panes = ["A", "B", "C", "active"].map(name => ({ name }));
  for (const pane of panes) {
    scheduler.register(pane, () => { paints.push(pane.name); now += 2; });
    scheduler.setContinuous(pane, true);
  }
  scheduler.setActive(panes[3], true);
  flushFrame(); flushFrame();
  assert.deepEqual(paints, ["active", "A", "B", "active", "C", "A"]);
  flushFrame();
  assert.deepEqual(paints.slice(6), ["active", "B", "C"]);
});

test("a costly active pane gives waiting backgrounds the first slot on alternating frames", () => {
  let now = 0;
  const { scheduler, flushFrame } = testScheduler({ now: () => now });
  const paints = [], panes = ["A", "B", "C", "active"].map(name => ({ name }));
  for (const pane of panes) {
    scheduler.register(pane, () => { paints.push(pane.name); now += 7; });
    scheduler.setContinuous(pane, true);
  }
  scheduler.setActive(panes[3], true);
  for (let i = 0; i < 12; i++) {
    scheduler.setActive(panes[3], true);
    flushFrame();
    assert.equal(paints.length, i + 1, "an atomic paint may exceed the budget, then must yield");
  }
  assert.deepEqual(paints, ["active", "A", "active", "B", "active", "C", "active", "A", "active", "B", "active", "C"]);
});

test("changing focus promotes the new active pane before previously deferred work", () => {
  let now = 0;
  const { scheduler, flushFrame } = testScheduler({ now: () => now });
  const paints = [], panes = ["A", "B", "C"].map(name => ({ name }));
  for (const pane of panes) scheduler.register(pane, () => { paints.push(pane.name); now += 6; });
  scheduler.setActive(panes[0], true); flushFrame();
  scheduler.setActive(panes[2], true); scheduler.setActive(panes[0], false); flushFrame();
  assert.deepEqual(paints, ["A", "C"]);
  flushFrame();
  assert.deepEqual(paints, ["A", "C", "B"]);
});

test("an idle active pane reserves no capacity and background-only work keeps rotating", () => {
  let now = 0;
  const { scheduler, flushFrame } = testScheduler({ now: () => now });
  const paints = [], active = {};
  scheduler.register(active, () => paints.push("active"));
  scheduler.setActive(active, true); flushFrame(); paints.length = 0;
  for (const name of ["A", "B", "C"]) {
    const pane = {};
    scheduler.register(pane, () => { paints.push(name); now += 6; });
    scheduler.setContinuous(pane, true);
  }
  for (let i = 0; i < 6; i++) flushFrame();
  assert.deepEqual(paints, ["A", "B", "C", "A", "B", "C"]);
});

test("a coalesced active paint does not hold a ready background pane", () => {
  let now = 0;
  const { scheduler, flushFrame } = testScheduler({ now: () => now });
  const active = { paintCoalescing: true }, background = {}, paints = [];
  scheduler.register(background, () => paints.push("background"));
  scheduler.register(active, () => paints.push("active"));
  scheduler.setActive(active, true); scheduler.noteOutput(active);
  flushFrame();
  assert.deepEqual(paints, ["background"]);
  assert.equal(scheduler.pending.has(active), true);
  active.interactivePaintUntil = 150;
  flushFrame();
  assert.deepEqual(paints, ["background", "active"], "typing still bypasses paint coalescing");
});

test("hiding and disposing deferred panes remove their work and active references", () => {
  let now = 0;
  const { scheduler, flushFrame, frames } = testScheduler({ now: () => now });
  const panes = [{}, {}, {}], paints = [];
  for (const [index, pane] of panes.entries()) scheduler.register(pane, () => { paints.push(index); now += 6; });
  scheduler.setActive(panes[0], true); flushFrame();
  scheduler.setPaused(panes[1], true); scheduler.unregister(panes[2]);
  assert.equal(frames.size, 0);
  scheduler.setPaused(panes[0], true);
  assert.equal(scheduler.activeTerminal, null);
  scheduler.setActive(panes[0], true);
  assert.equal(scheduler.activeTerminal, null, "a paused pane cannot regain painting priority");
  scheduler.setPaused(panes[0], false); scheduler.setActive(panes[0], true);
  flushFrame();
  assert.deepEqual(paints, [0, 0]);
  scheduler.unregister(panes[0]);
  assert.equal(scheduler.activeTerminal, null);
});

test("redraw requests made during painting survive without scheduling duplicate frames", () => {
  let now = 0, first = true;
  const { scheduler, flushFrame, frames } = testScheduler({ now: () => now });
  const a = {}, b = {}, paints = [];
  scheduler.register(a, () => {
    paints.push("A"); now += 6;
    if (first) { first = false; scheduler.request(a); }
  });
  scheduler.register(b, () => paints.push("B"));
  flushFrame();
  assert.equal(frames.size, 1);
  flushFrame();
  assert.deepEqual(paints, ["A", "B", "A"]);
  assert.equal(frames.size, 0);
});

test("a failing paint leaves sibling requests scheduled", () => {
  const { scheduler, flushFrame, frames } = testScheduler();
  const broken = {}, sibling = {};
  let paints = 0;
  scheduler.register(broken, () => { throw new Error("paint failed"); });
  scheduler.register(sibling, () => paints++);
  scheduler.setActive(broken, true);
  assert.throws(flushFrame, /paint failed/);
  assert.equal(frames.size, 1);
  flushFrame();
  assert.equal(paints, 1);
  assert.equal(frames.size, 0);
});

test("disabling rendering during a paint preserves siblings until visibility returns", () => {
  const { scheduler, flushFrame, frames } = testScheduler();
  const paints = [], a = {}, b = {};
  scheduler.register(a, () => { paints.push("A"); scheduler.setEnabled(false); });
  scheduler.register(b, () => paints.push("B"));
  flushFrame();
  assert.deepEqual(paints, ["A"]);
  assert.equal(frames.size, 0);
  scheduler.unregister(a); scheduler.setEnabled(true); flushFrame();
  assert.deepEqual(paints, ["A", "B"]);
});

test("fresh build output keeps background paint turns balanced", () => {
  let now = 0;
  const { scheduler, flushFrame } = testScheduler({ now: () => now });
  const panes = ["A", "B", "C", "active"].map(name => ({ name })), paints = [];
  for (const pane of panes) scheduler.register(pane, () => { paints.push(pane.name); now += 2; });
  scheduler.setActive(panes[3], true);
  for (let i = 0; i < 6; i++) {
    for (const pane of panes) scheduler.noteOutput(pane);
    flushFrame();
  }
  assert.equal(paints.filter(name => name === "active").length, 6);
  for (const name of ["A", "B", "C"]) assert.equal(paints.filter(value => value === name).length, 4);
});

test("a deferred FPS-capped pane advances its paint deadline only when it renders", () => {
  let now = 0;
  const { scheduler, flushFrame } = testScheduler({ now: () => now });
  const active = {}, background = { paintFPSLimit: 30 }, paints = [];
  scheduler.register(active, () => { paints.push("active"); now += 6; });
  scheduler.register(background, () => paints.push("background"));
  scheduler.setActive(active, true); flushFrame();
  assert.equal(scheduler.entries.get(background).nextPaint, null);
  now = 16; flushFrame();
  assert.deepEqual(paints, ["active", "background"]);
  assert.equal(scheduler.entries.get(background).nextPaint, 16 + 1000 / 30);
  now = 20; scheduler.noteOutput(background); flushFrame();
  assert.deepEqual(paints, ["active", "background"]);
  background.interactivePaintUntil = 170; flushFrame();
  assert.deepEqual(paints, ["active", "background", "background"], "typing bypasses the cap after a deferral");
});
