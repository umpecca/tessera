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
    // rubout is a shell's "\b \b": step back and blank the cell.
    rubout() { this.cursorX -= 1; cells.delete(`${this.cursorX},${this.cursorY}`); },
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
  assert.deepEqual(prediction.visible(), { cells: [{ col: 3, row: 0, char: "s" }], cursor: { col: 4, row: 0 }, cover: null });
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

test("a contradicted guess is withdrawn at once and the next epoch starts hidden", () => {
  const { prediction } = engine();
  const s = screen();
  prediction.input("a", s); s.echo("a"); prediction.check(s);
  prediction.input("b", s);
  assert.equal(prediction.visible().cells.length, 1);
  s.echo("X"); // The program drew something else, without waiting for a deadline.
  assert.equal(prediction.check(s), true, "the withdrawn prediction must be erased");
  assert.deepEqual(prediction.visible().cells, []);
  prediction.input("c", s);
  assert.deepEqual(prediction.visible().cells, [], "the next epoch starts hidden");
});

test("a guess is withdrawn when the cursor leaves its row", () => {
  const { prediction } = engine();
  const s = screen();
  prediction.input("a", s); s.echo("a"); prediction.check(s);
  prediction.input("b", s);
  s.cursorY = 1; s.cursorX = 0; // A background job printed a line.
  prediction.check(s);
  assert.equal(prediction.predictions.length, 0);
});

test("a late echo is waited for, not withdrawn early", () => {
  const { prediction, advance } = engine();
  const s = screen();
  prediction.input("a", s); advance(30); s.echo("a"); prediction.check(s);
  prediction.input("b", s);
  assert.equal(prediction.nextDeadline(), 30 + 600, "at least 600 ms on a fast link");
  advance(450); // A jitter spike: no echo yet, nothing contradicts the guess.
  prediction.check(s);
  assert.equal(prediction.visible().cells.length, 1);
  advance(100); s.echo("b");
  prediction.check(s);
  assert.equal(prediction.predictions.length, 0);
  assert.equal(prediction.epochConfirmed, true, "a late echo confirms; no reset happened");
  for (let i = 0; i < 40; i++) prediction.sample(400);
  prediction.input("c", s);
  assert.ok(Math.abs(prediction.nextDeadline() - (prediction.now() + 4 * prediction.srtt)) < 1, "four round trips on a slow link");
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
  for (const input of ["\r", "\x1b[A", "\x1b\x7f", "pasted text", "é", "\t"]) {
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

// confirmedLine leaves an engine in a confirmed epoch with `text` echoed.
function confirmedLine(text, mode = "always") {
  const { prediction, advance } = engine(mode);
  const s = screen();
  for (const ch of text) { prediction.input(ch, s); advance(30); s.echo(ch); prediction.check(s); }
  return { prediction, advance, s };
}

test("Backspace withdraws a character that is still only predicted", () => {
  const { prediction, s } = confirmedLine("ls");
  for (const ch of " -la") prediction.input(ch, s);
  assert.equal(prediction.input("\x7f", s), true);
  assert.deepEqual(prediction.visible(), {
    cells: [{ col: 4, row: 0, char: " " }, { col: 5, row: 0, char: "-" }, { col: 6, row: 0, char: "l" }],
    cursor: { col: 7, row: 0 },
    cover: null,
  });
  prediction.input("\b", s); // Ctrl+H counts too.
  assert.equal(prediction.visible().cells.length, 2);
});

test("Backspace over echoed text predicts an erase at the end of the line", () => {
  const { prediction, advance, s } = confirmedLine("cat");
  assert.equal(prediction.input("\x7f", s), true);
  // The real cursor still sits after "t"; the overlay blanks it so only the
  // predicted cursor shows.
  assert.deepEqual(prediction.visible(), { cells: [{ col: 4, row: 0, char: "" }], cursor: { col: 4, row: 0 }, cover: { col: 5, row: 0 } });
  prediction.input("\x7f", s);
  assert.deepEqual(prediction.visible().cursor, { col: 3, row: 0 });
  assert.deepEqual(prediction.visible().cover, { col: 5, row: 0 });
  advance(30);
  s.rubout();
  prediction.check(s);
  assert.equal(prediction.predictions.length, 1, "the first erase is confirmed alone");
  s.rubout();
  prediction.check(s);
  assert.equal(prediction.predictions.length, 0);
});

test("an erase and the next character confirm together when their echoes arrive together", () => {
  const { prediction, advance, s } = confirmedLine("cot");
  prediction.input("\x7f", s);
  prediction.input("\x7f", s);
  prediction.input("a", s);
  prediction.input("t", s);
  assert.deepEqual(prediction.visible().cells.map(c => [c.col, c.char]), [[4, ""], [3, ""], [3, "a"], [4, "t"]]);
  advance(30);
  s.rubout(); s.rubout(); s.echo("at"); // One output chunk.
  prediction.check(s);
  assert.equal(prediction.predictions.length, 0);
  assert.equal(prediction.epochConfirmed, true);
});

test("Backspace mid-line or at the left edge is not predicted", () => {
  const { prediction, s } = confirmedLine("abc");
  s.cursorX = 3; // The cursor moved back over "c" (an arrow key elsewhere).
  prediction.input("\x7f", s);
  assert.equal(prediction.predictions.length, 0);
  assert.equal(prediction.epochConfirmed, false, "text right of the cursor: start hidden");
  const edge = engine();
  edge.prediction.input("\x7f", screen({ cursorX: 0 }));
  assert.equal(edge.prediction.predictions.length, 0);
});

test("an erase the program refuses is withdrawn at its deadline", () => {
  const { prediction, advance, s } = confirmedLine("ab");
  prediction.input("\x7f", s);
  assert.equal(prediction.visible().cells.length, 1);
  advance(700); // The program never erased (Backspace into a prompt).
  assert.equal(prediction.check(s), true);
  assert.deepEqual(prediction.visible().cells, []);
  assert.equal(prediction.epochConfirmed, false);
});

test("Backspace in a password prompt draws nothing", () => {
  const { prediction, advance, s } = confirmedLine("read");
  prediction.input("\r", s);
  s.cursorY = 1; s.cursorX = 10;
  for (const key of ["s", "e", "\x7f", "\x7f", "\x7f", "x"]) {
    prediction.input(key, s);
    assert.deepEqual(prediction.visible().cells, []);
    advance(100);
    prediction.check(s);
  }
});

test("diagnostics say whether predictions are drawn and why", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const start = source.indexOf("function describeTypingPrediction(");
  const describe = vm.runInNewContext(`(${source.slice(start, source.indexOf("\n}\n", start) + 2)})`, {});
  assert.equal(describe({ mode: "auto", latencyMs: null, showing: false }), "Auto, not drawing (no echo measured yet; draws above 20 ms)");
  assert.equal(describe({ mode: "auto", latencyMs: 118, showing: true }), "Auto, drawing (echo 118 ms; draws above 20 ms)");
  assert.equal(describe({ mode: "always", latencyMs: 3, showing: false }), "Always, drawing (echo 3 ms)");
  assert.equal(describe({ mode: "off", latencyMs: null, showing: false }), "Off");
});
