import assert from "node:assert/strict";
import test from "node:test";
import { TerminalTouchScroll } from "./terminal-touch-scroll.mjs";

const touch = (pointerId, clientY) => ({ pointerType: "touch", pointerId, clientY });

test("one finger is left to the terminal", () => {
  const scroll = new TerminalTouchScroll();
  assert.equal(scroll.down(touch(1, 100)), false);
  assert.equal(scroll.move(touch(1, 60)), null);
  assert.equal(scroll.up(touch(1, 60)), false);
  assert.equal(scroll.down({ pointerType: "mouse", pointerId: 9, clientY: 0 }), false);
});

test("two fingers report how far their middle moved", () => {
  const scroll = new TerminalTouchScroll();
  scroll.down(touch(1, 100));
  scroll.move(touch(1, 90));
  assert.equal(scroll.down(touch(2, 110)), true, "the second finger starts a scroll");
  assert.equal(scroll.move(touch(1, 70)), -10);
  assert.equal(scroll.move(touch(2, 90)), -10);
});

test("the scroll keeps every finger until the last lifts", () => {
  const scroll = new TerminalTouchScroll();
  scroll.down(touch(1, 100));
  scroll.down(touch(2, 100));
  assert.equal(scroll.up(touch(1, 100)), true);
  assert.equal(scroll.move(touch(2, 40)), 0, "one finger left doesn't scroll or select");
  assert.equal(scroll.down(touch(3, 40)), true, "a finger landing again resumes");
  assert.equal(scroll.move(touch(3, 20)), -10);
  assert.equal(scroll.up(touch(2, 40)), true);
  assert.equal(scroll.up(touch(3, 20)), true);
  assert.equal(scroll.down(touch(4, 0)), false, "a new touch starts over");
});
