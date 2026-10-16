import assert from "node:assert/strict";
import test from "node:test";

import { normalizePredictionMode, TerminalPrediction } from "./terminal-prediction.mjs";

// A fake terminal: a cursor and a sparse grid of codepoints.
function screen(overrides = {}) {
  const cells = new Map();
  return {
    cols: 80, cursorX: 2, cursorY: 0, canPredict: true,
    cellAt(col, row) { return cells.get(`${col},${row}`) ?? 0; },
    // echo writes a character at the cursor and advances it, like a shell.
    echo(text) { for (const ch of text) { cells.set(`${this.cursorX},${this.cursorY}`, ch.charCodeAt(0)); this.cursorX += 1; } },
    ...overrides,
  };
}

function engine(mode = "always") {
  let time = 0;
  const prediction = new TerminalPrediction({ mode, now: () => time });
  return { prediction, advance(ms) { time += ms; } };
}

test("hides a new epoch until the server confirms one character", () => {
  const { prediction, advance } = engine();
  const s = screen();
  prediction.input("l", s);
  assert.deepEqual(prediction.visible().cells, [], "unconfirmed epoch stays hidden");
  advance(40);
  s.echo("l");
  assert.equal(prediction.check(s), false);
  assert.equal(prediction.predictions.length, 0, "confirmed prediction removed");
  assert.equal(prediction.input("s", s), true, "the confirmed epoch now shows predictions");
  assert.deepEqual(prediction.visible(), { cells: [{ col: 3, row: 0, char: "s" }], cursor: { col: 4, row: 0 } });
});

test("predictions advance along the line and are confirmed in order", () => {
  const { prediction, advance } = engine();
  const s = screen();
  prediction.input("e", s); advance(30); s.echo("e"); prediction.check(s);
  for (const ch of "cho") prediction.input(ch, s);
  assert.deepEqual(prediction.visible().cells.map(c => [c.col, c.char]), [[3, "c"], [4, "h"], [5, "o"]]);
  advance(30);
  s.echo("ch");
  assert.equal(prediction.check(s), true);
  assert.deepEqual(prediction.visible().cells.map(c => c.char), ["o"]);
  assert.ok(Math.abs(prediction.srtt - 30) < 1);
});

test("a password prompt never shows a character", () => {
  const { prediction, advance } = engine();
  const s = screen();
  prediction.input("a", s); advance(30); s.echo("a"); prediction.check(s);
  prediction.input("\r", s); // Enter: a new, unconfirmed epoch begins.
  s.cursorY = 1; s.cursorX = 10; // "Password: "
  for (const ch of "secret") {
    prediction.input(ch, s);
    assert.deepEqual(prediction.visible().cells, []);
    advance(100);
    prediction.check(s);
  }
  advance(1000);
  prediction.check(s);
  assert.equal(prediction.predictions.length, 0, "unconfirmed guesses are withdrawn");
  assert.equal(prediction.epochConfirmed, false);
});

test("a wrong or late guess resets to a hidden epoch", () => {
  const { prediction, advance } = engine();
  const s = screen();
  prediction.input("a", s); advance(30); s.echo("a"); prediction.check(s);
  prediction.input("b", s);
  assert.equal(prediction.visible().cells.length, 1);
  s.echo("X"); // The program drew something else.
  assert.equal(prediction.nextDeadline(), 30 + 250);
  advance(260);
  assert.equal(prediction.check(s), true, "the withdrawn prediction must be erased");
  assert.deepEqual(prediction.visible().cells, []);
  prediction.input("c", s);
  assert.deepEqual(prediction.visible().cells, [], "the next epoch starts hidden");
});

test("a character already on screen is not mistaken for an echo", () => {
  const { prediction } = engine();
  const s = screen();
  s.echo("x"); s.cursorX = 2; // An "x" sits under the cursor before typing.
  prediction.input("x", s);
  prediction.check(s);
  assert.equal(prediction.predictions.length, 1, "the cursor has not moved past it yet");
});

test("unpredictable input, wrap and unpredictable screens reset", () => {
  for (const input of ["\r", "\x7f", "\x1b[A", "pasted text", "é", "\t"]) {
    const { prediction } = engine();
    const s = screen();
    prediction.input("a", s);
    prediction.input(input, s);
    assert.equal(prediction.predictions.length, 0, JSON.stringify(input));
  }
  const { prediction } = engine();
  prediction.input("a", screen({ cursorX: 80 }));
  assert.equal(prediction.predictions.length, 0, "never guess a wrap");
  prediction.input("a", screen({ canPredict: false }));
  assert.equal(prediction.predictions.length, 0, "alternate screen switch or scrollback");
  const scrolled = engine();
  const s = screen();
  scrolled.prediction.input("a", s);
  s.canPredict = false;
  scrolled.prediction.check(s);
  assert.equal(scrolled.prediction.predictions.length, 0);
});

test("Auto shows predictions only on a slow link, with hysteresis", () => {
  const { prediction, advance } = engine("auto");
  const s = screen();
  const confirm = (ms) => { prediction.input("a", s); advance(ms); s.echo("a"); prediction.check(s); };
  for (let i = 0; i < 5; i++) confirm(2);
  prediction.input("b", s);
  assert.deepEqual(prediction.visible().cells, [], "LAN latency: nothing drawn");
  prediction.reset();
  for (let i = 0; i < 30; i++) confirm(60);
  assert.equal(prediction.showing, true);
  for (let i = 0; i < 3; i++) confirm(15);
  assert.equal(prediction.showing, true, "between the thresholds the last state holds");
  for (let i = 0; i < 40; i++) confirm(2);
  assert.equal(prediction.showing, false);
});

test("Off tracks nothing", () => {
  const { prediction } = engine("off");
  prediction.input("a", screen());
  assert.equal(prediction.predictions.length, 0);
  assert.equal(normalizePredictionMode("bogus"), "auto");
});
