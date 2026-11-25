import assert from "node:assert/strict";
import test from "node:test";
import { TerminalTextBlink, installTerminalTextBlink, terminalTextBlinkFlag } from "./terminal-text-blink.mjs";

test("blinking cells are noted as they are drawn and hidden in the hidden phase", () => {
  const drawn = [];
  class Renderer { renderCellText(cell) { drawn.push(cell.codepoint); } }
  installTerminalTextBlink(Renderer);
  installTerminalTextBlink(Renderer);
  const r = new Renderer();
  r.renderCellText({ codepoint: 65, flags: 0 });
  assert.equal(r.tesseraBlinkSeen, undefined);
  r.renderCellText({ codepoint: 66, flags: terminalTextBlinkFlag | 1 });
  assert.equal(r.tesseraBlinkSeen, true);
  r.tesseraBlinkHidden = true;
  r.renderCellText({ codepoint: 67, flags: terminalTextBlinkFlag });
  r.renderCellText({ codepoint: 68, flags: 1 });
  assert.deepEqual(drawn, [65, 66, 68], "only the blinking text goes");
});

function timers() {
  const live = new Map();
  let next = 1;
  return {
    live,
    setInterval(callback, interval) { live.set(next, { callback, interval }); return next++; },
    clearInterval(id) { live.delete(id); },
    tick() { for (const { callback } of [...live.values()]) callback(); },
  };
}

test("the timer runs only while blinking text is on screen", () => {
  const clock = timers();
  let toggles = 0, enabled = true;
  const blink = new TerminalTextBlink(() => toggles++, { timers: clock, enabled: () => enabled });
  blink.noteFrame(false, true);
  assert.equal(clock.live.size, 0, "no blinking text, no timer");
  blink.noteFrame(true, false);
  assert.equal(clock.live.size, 1);
  assert.equal([...clock.live.values()][0].interval, 500);
  blink.noteFrame(true, false);
  assert.equal(clock.live.size, 1, "one timer");
  clock.tick();
  assert.equal(blink.hidden, true); assert.equal(toggles, 1);
  blink.noteFrame(false, false);
  assert.equal(clock.live.size, 1, "a partial redraw without any proves nothing");
  blink.noteFrame(false, true);
  assert.equal(clock.live.size, 0, "a full redraw without any stops it");
  assert.equal(blink.hidden, false, "and shows the text");
  assert.equal(toggles, 2, "with one more redraw");

  enabled = false;
  blink.noteFrame(true, true);
  assert.equal(clock.live.size, 0, "steady when blinking is off or motion is reduced");
  enabled = true;
  blink.noteFrame(true, true); clock.tick();
  enabled = false;
  blink.noteFrame(true, false);
  assert.equal(clock.live.size, 0, "turning blinking off stops it at once");
  assert.equal(blink.hidden, false);
  blink.noteFrame(true, false); blink.dispose();
  assert.equal(clock.live.size, 0);
});
