import assert from "node:assert/strict";
import test from "node:test";

import { normalizePredictionMode, TerminalPrediction } from "./terminal-prediction.mjs";

// A fake terminal: a cursor and a sparse grid of codepoints.
function screen(overrides = {}) {
  const cells = new Map();
  const shiftCell = (from, to, row) => {
    const code = cells.get(`${from},${row}`);
    if (code === undefined) cells.delete(`${to},${row}`);
    else cells.set(`${to},${row}`, code);
  };
  return {
    cols: 80, cursorX: 2, cursorY: 0, canPredict: true,
    cellAt(col, row) { return cells.get(`${col},${row}`) ?? 0; },
    // echo writes a character at the cursor and advances it, like a shell.
    echo(text) { for (const ch of text) { cells.set(`${this.cursorX},${this.cursorY}`, ch.charCodeAt(0)); this.cursorX += 1; } },
    // rubout is a shell's "\b \b": step back and blank the cell.
    rubout() { this.cursorX -= 1; cells.delete(`${this.cursorX},${this.cursorY}`); },
    // insert and pull redraw the line as a shell does when editing mid-line:
    // the rest of the line shifts right after typing, left after Backspace.
    insert(text) {
      for (const ch of text) {
        for (let col = this.cols - 1; col > this.cursorX; col--) shiftCell(col - 1, col, this.cursorY);
        cells.set(`${this.cursorX},${this.cursorY}`, ch.charCodeAt(0));
        this.cursorX += 1;
      }
    },
    pull() {
      this.cursorX -= 1;
      for (let col = this.cursorX; col < this.cols - 1; col++) shiftCell(col + 1, col, this.cursorY);
      cells.delete(`${this.cols - 1},${this.cursorY}`);
    },
    put(col, text) { for (const ch of text) cells.set(`${col++},${this.cursorY}`, ch.codePointAt(0)); },
    text(row = 0) { let line = ""; for (let col = 0; col < this.cols; col++) line += String.fromCodePoint(cells.get(`${col},${row}`) || 0x20); return line.trimEnd(); },
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
  assert.deepEqual(prediction.visible(), { cells: [{ col: 3, row: 0, char: "s", underline: true }], cursor: { col: 4, row: 0 }, cover: null });
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
    cells: [{ col: 4, row: 0, char: " ", underline: true }, { col: 5, row: 0, char: "-", underline: true }, { col: 6, row: 0, char: "l", underline: true }],
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
  assert.deepEqual(prediction.visible(), { cells: [{ col: 4, row: 0, char: "", underline: false }], cursor: { col: 4, row: 0 }, cover: { col: 5, row: 0, char: "" } });
  prediction.input("\x7f", s);
  assert.deepEqual(prediction.visible().cursor, { col: 3, row: 0 });
  assert.deepEqual(prediction.visible().cover, { col: 5, row: 0, char: "" });
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
  // Only cells that differ from the screen, or hold a typed character, draw.
  assert.deepEqual(prediction.visible().cells.map(c => [c.col, c.char]), [[3, "a"], [4, "t"]]);
  advance(30);
  s.rubout(); s.rubout(); s.echo("at"); // One output chunk.
  prediction.check(s);
  assert.equal(prediction.predictions.length, 0);
  assert.equal(prediction.epochConfirmed, true);
});

test("Backspace mid-line is predicted only within typed text", () => {
  const { prediction, s } = confirmedLine("abc");
  s.put(0, "$ "); // The prompt.
  s.cursorX = 3; // Moved back over "bc" by keys the engine did not see.
  prediction.input("\x7f", s);
  assert.deepEqual(prediction.visible().cells.map(c => [c.col, c.char]), [[2, "b"], [3, "c"], [4, ""]], "the rest of the line pulled left");
  const prompt = confirmedLine("abc");
  prompt.s.put(0, "$ ");
  prompt.s.cursorX = 2;
  prompt.prediction.input("\x7f", prompt.s); // Into the prompt.
  assert.equal(prompt.prediction.predictions.length, 0);
  assert.equal(prompt.prediction.epochConfirmed, false, "unpredictable: start hidden");
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

// promptLine is confirmedLine after a "$ " prompt, as a shell draws it.
function promptLine(text, mode = "always") {
  const { prediction, advance } = engine(mode);
  const s = screen();
  s.put(0, "$ ");
  for (const ch of text) { prediction.input(ch, s); advance(30); s.echo(ch); prediction.check(s); }
  return { prediction, advance, s };
}

// shown is the line as the overlay makes it look: the screen with the
// visible cells drawn over it.
function shown(prediction, s) {
  const line = [...s.text().padEnd(20)];
  for (const cell of prediction.visible().cells) line[cell.col] = cell.char || " ";
  return line.join("").trimEnd();
}

test("Left and Right move the predicted cursor within typed text", () => {
  const { prediction, advance, s } = promptLine("ls -la");
  assert.equal(prediction.input("\x1b[D", s), true);
  prediction.input("\x1bOD", s); // Application cursor mode.
  assert.deepEqual(prediction.visible(), {
    cells: [],
    cursor: { col: 6, row: 0, char: "l" },
    cover: { col: 8, row: 0, char: "" },
  }, "the cursor sits on the l; the real cursor at the end is hidden");
  prediction.input("\x1b[C", s);
  assert.deepEqual(prediction.visible().cursor, { col: 7, row: 0, char: "a" });
  advance(30);
  s.cursorX = 7; // The shell moved its cursor: Left, Left, Right.
  prediction.check(s);
  assert.equal(prediction.predictions.length, 0);
});

test("Left never enters the prompt and Right never passes the end of the text", () => {
  const { prediction, s } = promptLine("ab");
  prediction.input("\x1b[D", s);
  prediction.input("\x1b[D", s);
  assert.equal(prediction.predictions.length, 2);
  prediction.input("\x1b[D", s); // Onto the "$ " prompt.
  assert.equal(prediction.predictions.length, 0);
  assert.equal(prediction.epochConfirmed, false);
  const end = promptLine("ab");
  end.prediction.input("\x1b[C", end.s);
  assert.equal(end.prediction.predictions.length, 0, "already at the end of the text");
  const enter = promptLine("ab");
  enter.prediction.input("\r", enter.s);
  enter.s.cursorY = 1; enter.s.cursorX = 2; enter.s.put(0, "$ ");
  enter.prediction.input("\x1b[D", enter.s);
  assert.equal(enter.prediction.inputStart, null, "a new line has no typed text yet");
  assert.equal(enter.prediction.predictions.length, 0);
});

test("typing mid-line shifts the rest of the line until the shell confirms it", () => {
  const { prediction, advance, s } = promptLine("echo hllo");
  for (let i = 0; i < 3; i++) prediction.input("\x1b[D", s);
  prediction.input("e", s);
  assert.equal(shown(prediction, s), "$ echo hello");
  const typed = prediction.visible().cells.filter(c => c.underline).map(c => [c.col, c.char]);
  assert.deepEqual(typed, [[8, "e"]], "only the typed character is underlined");
  assert.deepEqual(prediction.visible().cursor, { col: 9, row: 0, char: "l" });
  advance(30);
  s.cursorX = 8; s.insert("e"); // Left, Left, Left, then the shell's insert.
  assert.equal(prediction.check(s), true);
  assert.equal(prediction.predictions.length, 0);
  assert.equal(s.text(), "$ echo hello");
});

test("a typo fixed mid-line is predicted end to end", () => {
  const { prediction, advance, s } = promptLine("echo hxllo");
  for (let i = 0; i < 3; i++) prediction.input("\x1b[D", s);
  prediction.input("\x7f", s);
  assert.equal(shown(prediction, s), "$ echo hllo");
  prediction.input("e", s);
  assert.equal(shown(prediction, s), "$ echo hello");
  advance(30);
  s.cursorX = 9; s.pull(); s.insert("e"); // All echoes in one chunk.
  prediction.check(s);
  assert.equal(prediction.predictions.length, 0);
  assert.deepEqual(prediction.visible().cells, []);
  assert.equal(prediction.epochConfirmed, true);
});

test("mid-line edits are not predicted over wide text or at the right edge", () => {
  const wide = promptLine("ab");
  wide.s.put(4, "界"); wide.s.cursorX = 3;
  wide.prediction.input("x", wide.s);
  assert.equal(wide.prediction.predictions.length, 0, "a wide character would shift two cells");
  const full = promptLine("ab");
  full.s.put(4, "x".repeat(76)); full.s.cursorX = 3;
  full.prediction.input("y", full.s);
  assert.equal(full.prediction.predictions.length, 0, "the shell would wrap the line");
});

test("a cursor that lands somewhere no prediction leads withdraws them at once", () => {
  const { prediction, s } = promptLine("git st");
  s.put(8, "atus"); s.cursorX = 6; // A suggestion right of the cursor.
  prediction.input("\x1b[C", s);
  assert.equal(prediction.predictions.length, 1);
  s.cursorX = 12; // Right accepted the whole suggestion instead.
  assert.equal(prediction.check(s), true);
  assert.equal(prediction.predictions.length, 0);
});

test("a deadline check without output never confirms", () => {
  const { prediction, advance, s } = promptLine("a");
  prediction.input("b", s);
  advance(30); s.echo("b");
  prediction.check(s, { output: false });
  assert.equal(prediction.predictions.length, 1);
  prediction.check(s);
  assert.equal(prediction.predictions.length, 0);
});

test("a run that ends where it started confirms without proving an echo", () => {
  const { prediction, advance, s } = promptLine("ab");
  prediction.input("\t", s); // Unpredictable: a hidden epoch on the same line.
  const srtt = prediction.srtt;
  prediction.input("x", s);
  prediction.input("\x1b[D", s);
  advance(500);
  s.echo("x"); s.cursorX -= 1; // Both echoes arrive together.
  prediction.check(s);
  assert.equal(prediction.predictions.length, 0, "the screen shows the run");
  assert.equal(prediction.epochConfirmed, false, "but the cursor is back where it was, so the epoch stays hidden");
  assert.equal(prediction.srtt, srtt, "and no latency is sampled");
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

test("recent echoes are split into time before sending, until the reply is handled, and applying", () => {
  const { prediction, advance } = engine();
  const s = screen();
  assert.equal(prediction.latencyBreakdown(), null);
  for (const [ch, beforeSend, transit, apply] of [["a", 1, 30, 2], ["b", 3, 40, 1], ["c", 2, 50, 3]]) {
    prediction.input(ch, s);
    advance(beforeSend); prediction.noteSent();
    advance(transit); prediction.noteArrival();
    advance(apply); s.echo(ch); prediction.check(s);
  }
  assert.deepEqual(prediction.latencyBreakdown(), { count: 3, total: 44, beforeSend: 2, transit: 40, apply: 2 });

  // A reply that arrived before the send was made cannot be split.
  prediction.noteArrival(); advance(1);
  prediction.input("d", s); prediction.noteSent();
  advance(30); s.echo("d"); prediction.check(s);
  assert.equal(prediction.latencyBreakdown().count, 3);
});

test("diagnostics describe the echo breakdown", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const start = source.indexOf("function describeEchoBreakdown(");
  const describe = vm.runInNewContext(`(${source.slice(start, source.indexOf("\n}\n", start) + 2)})`, {});
  assert.equal(describe(null), "");
  assert.equal(describe({ count: 64, total: 43.6, beforeSend: 0.42, transit: 41.2, apply: 1.25 }),
    "; last 64 echoes, medians: 44 ms total, 0.4 ms before sending, 41 ms until the reply is handled, 1.3 ms applying");
});
