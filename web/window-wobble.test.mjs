import assert from "node:assert/strict";
import test from "node:test";
import { WindowWobble } from "./window-wobble.mjs";

function fixture() {
  const callbacks = new Map();
  let serial = 0;
  let enabled = true;
  let time = 0;
  const element = () => ({
    isConnected: true,
    style: {
      transform: "translate(120px, 160px)", width: "640px", height: "360px",
      removeProperty(name) { delete this[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; },
    },
  });
  const wobble = new WindowWobble({
    enabled: () => enabled,
    requestFrame(callback) { callbacks.set(++serial, callback); return serial; },
    cancelFrame(id) { callbacks.delete(id); },
  });
  function frame(delta = 1000 / 60) {
    time += delta;
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach(callback => callback(time));
  }
  return { wobble, element, callbacks, frame, disable: () => { enabled = false; } };
}

test("only movement starts animation and saved translation/size remain untouched", () => {
  const f = fixture();
  const element = f.element();
  f.wobble.start(element, 120, 160, 90, 16);
  assert.equal(f.callbacks.size, 0);
  f.wobble.move(120, 160);
  assert.equal(f.callbacks.size, 0);
  f.wobble.move(170, 190);
  f.wobble.move(190, 200);
  assert.equal(f.callbacks.size, 1, "pointer events share one frame");
  f.frame();
  assert.notEqual(parseFloat(element.style.rotate), 0);
  assert.notEqual(element.style.scale, "1.0000 1.0000");
  assert.equal(element.style.transformOrigin, "90px 16px");
  assert.equal(element.style.transform, "translate(120px, 160px)");
  assert.equal(element.style.width, "640px");
  assert.equal(element.style.height, "360px");
});

test("release settles, overshoots gently, and removes every temporary style", () => {
  for (const delta of [1000 / 30, 1000 / 60, 1000 / 120]) {
    const f = fixture();
    const element = f.element();
    f.wobble.start(element, 0, 0, 16, 16);
    f.wobble.move(60, 0);
    f.frame(delta);
    f.wobble.release();
    let positive = false;
    for (let i = 0; i < 300 && f.callbacks.size; i++) {
      f.frame(delta);
      positive ||= parseFloat(element.style.rotate) > 0;
    }
    assert.ok(positive, "spring crosses its resting point");
    assert.equal(f.callbacks.size, 0);
    assert.equal(f.wobble.state, null);
    assert.equal(element.style.rotate, undefined);
    assert.equal(element.style.scale, undefined);
    assert.equal(element.style.transformOrigin, undefined);
  }
});

test("a paused drag stops scheduling and resumes on new movement", () => {
  const f = fixture();
  const element = f.element();
  f.wobble.start(element, 0, 0, 20, 16);
  f.wobble.move(30, 0);
  for (let i = 0; i < 150 && f.callbacks.size; i++) f.frame();
  assert.equal(f.callbacks.size, 0);
  assert.ok(f.wobble.state.dragging);
  assert.equal(element.style.rotate, undefined);
  f.wobble.move(80, 0);
  assert.equal(f.callbacks.size, 1);
  f.frame();
  assert.notEqual(parseFloat(element.style.rotate), 0);
});

test("preference changes, cancellation, detached nodes, and a new drag clean up", () => {
  for (const action of ["stop", "disable", "detach", "new-drag"]) {
    const f = fixture();
    const element = f.element();
    f.wobble.start(element, 0, 0, 20, 16);
    f.wobble.move(60, 40);
    f.frame();
    if (action === "stop") f.wobble.stop();
    if (action === "disable") { f.disable(); f.frame(); }
    if (action === "detach") { element.isConnected = false; f.frame(); }
    if (action === "new-drag") f.wobble.start(f.element(), 0, 0, 20, 16);
    assert.equal(element.style.rotate, undefined, action);
    assert.equal(element.style.scale, undefined, action);
    assert.equal(element.style.transformOrigin, undefined, action);
    assert.equal(f.callbacks.size, 0, action);
  }
});

test("reduced-motion/performance opt-out never starts and other panes do not cancel this drag", () => {
  const f = fixture();
  const element = f.element();
  f.wobble.start(element, 0, 0, 20, 16);
  f.wobble.move(50, 0);
  f.wobble.stop(f.element());
  assert.equal(f.callbacks.size, 1);
  f.wobble.stop(element);
  assert.equal(f.callbacks.size, 0);
  f.disable();
  f.wobble.start(element, 0, 0, 20, 16);
  f.wobble.move(50, 0);
  assert.equal(f.wobble.state, null);
  assert.equal(f.callbacks.size, 0);
});

test("extreme impulses and a stalled frame remain bounded", () => {
  const f = fixture();
  const element = f.element();
  f.wobble.start(element, 0, 0, 20, 16);
  for (let frame = 0; frame < 30; frame++) {
    for (let event = 0; event < 100; event++) f.wobble.move((frame * 100 + event) * 10000, 1000000);
    f.frame(5000);
    assert.ok(Math.abs(parseFloat(element.style.rotate)) <= 1.12);
    for (const scale of element.style.scale.split(" ").map(Number)) assert.ok(scale >= 1 && scale < 1.01);
    assert.ok(f.callbacks.size <= 1);
  }
  f.wobble.stop();
});
