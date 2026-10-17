// Predictive local echo, after mosh. Typed characters are drawn at once over
// the terminal and confirmed against the cells the server later draws; the
// real terminal state is never touched.
//
// Safety comes from epochs: any input that cannot be predicted (Enter, Up,
// Tab, paste) or any wrong guess starts a new epoch, and a prediction is
// shown only once its epoch has had one confirmed character.
//
// Predictions are edits replayed over the real line: a character inserted at
// the cursor (shifting the rest of the line right), an erase before it
// (Backspace, pulling the rest left), or a cursor move (Left and Right).
// Edits mid-line stay within text typed on this line and plain ASCII, so the
// prompt and wide characters are never guessed at.
// Where nothing echoes, such as a password prompt, nothing is ever shown.

export const predictionModes = ["auto", "always", "off"];
const showAboveMs = 20;
const hideBelowMs = 10;
// Guesses are drawn like real text unless one could stay wrong long enough
// to notice, as mosh does: underlined while echo is slow, and after a wrong
// or slow guess until enough later echoes have come back quickly.
const underlineAboveMs = 80;
const plainBelowMs = 50;
const glitchMs = 250;
const glitchRepairs = 10;
const repairIntervalMs = 150;
// A guess the screen contradicts is dropped at once; one merely unconfirmed
// gets this long, so a late echo on a jittery link does not make typed text
// vanish and reappear.
const minimumJudgeMs = 600;
const maximumJudgeMs = 3000;
const judgeRoundTrips = 4;
// Recent echoes kept for the latency breakdown in diagnostics.
const breakdownSamples = 64;
// Left and Right, in normal and application cursor mode.
const arrows = new Map([["\x1b[D", -1], ["\x1bOD", -1], ["\x1b[C", 1], ["\x1bOC", 1]]);

const isBlank = code => code === 0 || code === 0x20;
const isAscii = code => code >= 0x20 && code <= 0x7e;
const sameCell = (code, expected) => code === expected || (expected === 0x20 && code === 0);

export function normalizePredictionMode(value) {
  return predictionModes.includes(value) ? value : "auto";
}

// A screen is what the engine may read of the real terminal:
// { cols, cursorX, cursorY, canPredict, cellAt(col, row) -> codepoint }.
//
// A prediction is { kind: "char" | "erase" | "move", col, row, before,
// after, sentAt }: the cell it acts on, and the cursor column before and
// after it.
export class TerminalPrediction {
  constructor({ mode = "auto", now = () => globalThis.performance.now() } = {}) {
    this.mode = normalizePredictionMode(mode);
    this.now = now;
    this.predictions = [];
    this.epoch = 0;
    this.epochConfirmed = false;
    this.srtt = null;
    this.showing = false;
    this.slow = false;
    // Quick echoes still needed after a wrong or slow guess, and when the
    // last one counted: fast typing alone does not clear it.
    this.glitches = 0;
    this.repairedAt = -Infinity;
    // The latest screen, and the cells read from it so far.
    this.screen = null;
    this.cells = new Map();
    // Where the terminal draws its own cursor, and the cell under it.
    this.realCursor = null;
    // The leftmost column typed into on the cursor's row since Enter: Left
    // and mid-line Backspace never go further, so they stay out of the prompt.
    this.inputStart = null;
    // When the handler for the latest server message started, and the recent
    // echoes split into the stages before and after it.
    this.arrivedAt = null;
    this.breakdown = [];
    this.inputAt = null;
  }

  setMode(mode) {
    this.mode = normalizePredictionMode(mode);
    if (this.mode === "off") return this.reset();
    return false;
  }

  // reset forgets every prediction and where typed text starts, and begins a
  // new, unconfirmed epoch. It reports whether anything visible changed.
  reset() {
    this.inputStart = null;
    return this.restart();
  }

  // restart begins a new, unconfirmed epoch on the same line.
  restart() {
    const changed = this.signature() !== "";
    this.predictions = [];
    this.epoch += 1;
    this.epochConfirmed = false;
    return changed;
  }

  // input sees each chunk of keyboard input before it is sent.
  input(data, screen) {
    if (this.mode === "off") return false;
    // Taken first, so reading the screen counts as time before sending.
    this.inputAt = this.now();
    this.observe(screen);
    if (!screen.canPredict || data === "\r") return this.reset();
    if (this.inputStart && this.inputStart.row !== screen.cursorY) this.inputStart = null;
    if (data === "\x7f" || data === "\b") return this.backspace(screen);
    if (arrows.has(data)) return this.move(arrows.get(data), screen);
    const code = data.length === 1 ? data.charCodeAt(0) : -1;
    if (!isAscii(code)) return this.restart();
    return this.insert(code, screen);
  }

  insert(code, screen) {
    const before = this.signature();
    const { col, row } = this.predictedCursor(screen);
    // Predicting past the last column would mean guessing the wrap.
    if (col >= screen.cols) return this.restart();
    const line = this.line(screen);
    // Mid-line the shell shifts the rest of the line right.
    if (!line.blankFrom(col) && (line.textEnd(col) >= screen.cols || !line.asciiFrom(col))) return this.restart();
    this.predictions.push({ kind: "char", col, row, code, before: col, after: col + 1, sentAt: this.inputAt });
    return before !== this.signature();
  }

  backspace(screen) {
    const before = this.signature();
    const last = this.predictions.at(-1);
    if (last?.kind === "char") {
      // The character and this Backspace reach the server together, so the
      // line ends up as if neither was typed.
      this.predictions.pop();
      return before !== this.signature();
    }
    const { col: cursor, row } = this.predictedCursor(screen);
    const col = cursor - 1;
    if (col < 0) return this.restart();
    const line = this.line(screen);
    // Mid-line the shell pulls the rest of the line left.
    if (!line.blankFrom(cursor) && !(this.withinInput(row, col) && line.asciiFrom(col))) return this.restart();
    this.predictions.push({ kind: "erase", col, row, before: cursor, after: col, sentAt: this.inputAt });
    return before !== this.signature();
  }

  move(direction, screen) {
    const before = this.signature();
    const { col, row } = this.predictedCursor(screen);
    const target = col + direction;
    const line = this.line(screen);
    const allowed = direction < 0
      ? this.withinInput(row, target) && isAscii(line.at(target))
      // Right moves over text; the shell will not go past the end of it.
      : target < screen.cols && isAscii(line.at(col)) && !line.blankFrom(col);
    if (!allowed) return this.restart();
    this.predictions.push({ kind: "move", col, row, before: col, after: target, sentAt: this.inputAt });
    return before !== this.signature();
  }

  withinInput(row, col) {
    return this.inputStart?.row === row && col >= this.inputStart.col;
  }

  // noteSent marks when the input just predicted left the page, so the time
  // spent drawing it beforehand is not counted as network.
  noteSent() {
    const last = this.predictions.at(-1);
    if (last && last.sentDoneAt === undefined) last.sentDoneAt = this.now();
  }

  // noteArrival runs as the handler for a server message starts.
  noteArrival() {
    this.arrivedAt = this.now();
  }

  // predictedCursor is where the cursor will be once every prediction lands.
  predictedCursor(screen) {
    const last = this.predictions.at(-1);
    if (!last) return { col: screen.cursorX, row: screen.cursorY };
    return { col: last.after, row: last.row };
  }

  // observe adopts a fresh screen; cells read from the previous one are stale.
  observe(screen) {
    this.screen = screen;
    this.cells.clear();
    this.realCursor = { col: screen.cursorX, row: screen.cursorY, code: this.cell(screen.cursorX, screen.cursorY) };
  }

  cell(col, row) {
    const key = `${col},${row}`;
    if (!this.cells.has(key)) this.cells.set(key, this.screen.cellAt(col, row));
    return this.cells.get(key);
  }

  // line replays the predictions over the real row. The cells it tracks run
  // from the leftmost one a prediction touches to the end of the text there,
  // the first never-written cell, so a right prompt past it is not shifted.
  line(screen) {
    const first = this.predictions[0];
    const row = first ? first.row : screen.cursorY;
    const cols = screen.cols;
    let from = first ? first.before : screen.cursorX;
    let to = from;
    for (const { col, before, after } of this.predictions) {
      from = Math.min(from, col, before, after);
      to = Math.max(to, col, before, after);
    }
    while (to < cols && this.cell(to, row) !== 0) to++;
    const cells = [];
    for (let col = from; col < to; col++) cells.push(this.cell(col, row));
    const typed = cells.map(() => false);
    let cursor = first ? first.before : screen.cursorX;
    for (const prediction of this.predictions) {
      const index = prediction.col - from;
      if (prediction.kind === "char") {
        cells.splice(index, 0, prediction.code);
        typed.splice(index, 0, true);
      } else if (prediction.kind === "erase") {
        cells.splice(index, 1);
        typed.splice(index, 1);
      }
      cursor = prediction.after;
    }
    const at = (col) => {
      if (col < 0 || col >= cols) return 0;
      if (col < from) return this.cell(col, row);
      if (col - from < cells.length) return cells[col - from];
      // Cells a shorter line vacated are blank; beyond the text, unchanged.
      return col < to ? 0 : this.cell(col, row);
    };
    const textEnd = (col) => {
      let end = col;
      while (end < cols && at(end) !== 0) end++;
      return end;
    };
    return {
      row, from, to, cells, typed, cursor, at, textEnd,
      // blankFrom: nothing but spaces from col to the end of the text.
      blankFrom: (col) => {
        for (let x = col, end = textEnd(col); x < end; x++) if (at(x) !== 0x20) return false;
        return true;
      },
      // asciiFrom: plain single-width text from col to the end of the text.
      asciiFrom: (col) => {
        for (let x = col, end = textEnd(col); x < end; x++) if (!isAscii(at(x))) return false;
        return true;
      },
    };
  }

  // check runs after server output is applied, and at deadlines without it
  // (output false): confirmed predictions are removed (the real characters
  // are drawn now), and wrong or late ones reset.
  check(screen, { output = true } = {}) {
    if (!this.predictions.length) return false;
    const before = this.signature();
    this.observe(screen);
    if (!screen.canPredict) {
      this.reset();
      return before !== this.signature();
    }
    const now = this.now();
    // Only output can show the server acted; a deadline check confirms nothing.
    if (output) this.confirm(screen, now);
    const first = this.predictions[0];
    if (first && (this.contradicted(screen, output) || now >= this.deadline(first))) {
      if (this.isVisible()) this.glitches = glitchRepairs;
      this.reset();
    }
    return before !== this.signature();
  }

  // replay walks the predictions, tracking where each predicted character
  // ends up, and calls visit(index, chars) after each one.
  replay(visit) {
    let chars = [];
    for (let index = 0; index < this.predictions.length; index++) {
      const prediction = this.predictions[index];
      if (prediction.kind === "char") {
        for (const char of chars) if (char.col >= prediction.col) char.col += 1;
        chars.push({ col: prediction.col, code: prediction.code });
      } else if (prediction.kind === "erase") {
        chars = chars.filter(char => char.col !== prediction.col);
        for (const char of chars) if (char.col > prediction.col) char.col -= 1;
      }
      visit(index, chars);
    }
  }

  // shows reports whether the screen holds the state after a prediction: the
  // real cursor where it leaves it and every predicted character in its cell.
  shows(screen, index, chars) {
    const prediction = this.predictions[index];
    return screen.cursorY === prediction.row && screen.cursorX === prediction.after
      && chars.every(char => sameCell(this.cell(char.col, prediction.row), char.code));
  }

  // confirm drops the longest run of predictions the screen already shows.
  confirm(screen, now) {
    let count = 0;
    let shown = [];
    this.replay((index, chars) => {
      if (this.shows(screen, index, chars)) { count = index + 1; shown = chars.map(char => ({ ...char })); }
    });
    if (!count) return;
    const run = this.predictions.splice(0, count);
    const row = run[0].row;
    for (const { col } of shown) {
      if (this.inputStart?.row !== row) this.inputStart = { row, col };
      else this.inputStart.col = Math.min(this.inputStart.col, col);
    }
    // A run that leaves the cursor where it started proves nothing: the
    // screen may simply not have changed yet.
    if (run.at(-1).after === run[0].before) return;
    // Only a guess that was drawn can have looked wrong for too long.
    const drawn = this.isVisible();
    for (const prediction of run) {
      if (prediction.kind === "move") continue;
      this.sample(now - prediction.sentAt);
      if (drawn) this.repair(now - prediction.sentAt, now);
      this.recordBreakdown(prediction, now);
      this.epochConfirmed = true;
    }
  }

  // contradicted reports guesses the screen already shows to be wrong: the
  // cursor left their row or every place they could leave it, or (after
  // output) it stands where only the server acting on them would put it, yet
  // a predicted character is not there. A refused erase or move cannot be
  // told apart from a slow one, so it waits for its deadline.
  contradicted(screen, output) {
    const first = this.predictions[0];
    if (screen.cursorY !== first.row) return true;
    let low = first.before, high = first.before;
    for (const { after } of this.predictions) {
      low = Math.min(low, after);
      high = Math.max(high, after);
    }
    if (screen.cursorX < low || screen.cursorX > high) return true;
    if (!output) return false;
    let wrong = false;
    this.replay((index, chars) => {
      const { after } = this.predictions[index];
      if (after === screen.cursorX && after !== first.before && !this.shows(screen, index, chars)) wrong = true;
    });
    return wrong;
  }

  // signature changes exactly when what should be drawn changes.
  signature() {
    const { cells, cursor, cover } = this.visible();
    return cells.map(cell => `${cell.col},${cell.row},${cell.char},${cell.underline ? 1 : 0}`).join(";")
      + (cursor ? `@${cursor.col},${cursor.row}` : "") + (cover ? `|${cover.col},${cover.row},${cover.char}` : "");
  }

  sample(ms) {
    if (!(ms >= 0)) return;
    this.srtt = this.srtt === null ? ms : this.srtt + (ms - this.srtt) / 8;
    if (this.srtt > showAboveMs) this.showing = true;
    else if (this.srtt < hideBelowMs) this.showing = false;
    if (this.srtt > underlineAboveMs) this.slow = true;
    else if (this.srtt < plainBelowMs) this.slow = false;
  }

  // repair counts one echo toward drawing guesses plain again after a
  // glitch; a slow one starts the count over.
  repair(ms, now) {
    if (ms > glitchMs) this.glitches = glitchRepairs;
    else if (this.glitches > 0 && now - this.repairedAt >= repairIntervalMs) {
      this.glitches -= 1;
      this.repairedAt = now;
    }
  }

  // underlined reports whether guesses are marked as unconfirmed.
  underlined() {
    return this.slow || this.glitches > 0;
  }

  // recordBreakdown splits one echo into time before the send, time until the
  // page handled the server's message, and time applying it, when the
  // confirming message arrived after the send.
  recordBreakdown(prediction, now) {
    const { sentAt, sentDoneAt } = prediction;
    if (sentDoneAt === undefined || this.arrivedAt === null || this.arrivedAt < sentDoneAt) return;
    this.breakdown.push({ total: now - sentAt, beforeSend: sentDoneAt - sentAt, transit: this.arrivedAt - sentDoneAt, apply: now - this.arrivedAt });
    if (this.breakdown.length > breakdownSamples) this.breakdown.shift();
  }

  // latencyBreakdown reports median milliseconds for each stage of recent
  // echoes, or null before any.
  latencyBreakdown() {
    if (!this.breakdown.length) return null;
    const median = (key) => {
      const values = this.breakdown.map(sample => sample[key]).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    };
    return { count: this.breakdown.length, total: median("total"), beforeSend: median("beforeSend"), transit: median("transit"), apply: median("apply") };
  }

  deadline(prediction) {
    const judge = Math.min(maximumJudgeMs, Math.max(minimumJudgeMs, judgeRoundTrips * (this.srtt ?? 0)));
    return prediction.sentAt + judge;
  }

  // nextDeadline is when check must run even without output, so a guess the
  // server never confirms (a password prompt) is withdrawn.
  nextDeadline() {
    return this.predictions.length ? this.deadline(this.predictions[0]) : null;
  }

  isVisible() {
    return this.epochConfirmed && this.mode !== "off" && (this.mode === "always" || this.showing);
  }

  // visible lists the cells to draw where the predicted line differs from the
  // real one (predicted characters underlined while marked), where the
  // cursor should appear and the character under it, and the real cursor's
  // cell to redraw without its cursor, so only one cursor shows.
  visible() {
    if (!this.predictions.length || !this.isVisible() || !this.screen) return { cells: [], cursor: null, cover: null };
    const line = this.line(this.screen);
    const marked = this.underlined();
    const cells = [];
    const span = Math.min(Math.max(line.cells.length, line.to - line.from), this.screen.cols - line.from);
    for (let index = 0; index < span; index++) {
      const col = line.from + index;
      const code = line.cells[index] ?? 0;
      const real = this.cell(col, line.row);
      const typed = line.typed[index] ?? false;
      if (!typed && (code === real || (isBlank(code) && isBlank(real)))) continue;
      const char = typed || !isBlank(code) ? String.fromCharCode(code) : "";
      cells.push({ col, row: line.row, char, underline: typed && marked });
    }
    const cursor = { col: line.cursor, row: line.row };
    const under = line.at(line.cursor);
    if (!isBlank(under)) cursor.char = String.fromCharCode(under);
    const real = this.realCursor;
    const covered = !real || (real.col === cursor.col && real.row === cursor.row)
      || cells.some(cell => cell.col === real.col && cell.row === real.row);
    const cover = covered ? null : { col: real.col, row: real.row, char: isBlank(real.code) ? "" : String.fromCodePoint(real.code) };
    return { cells, cursor, cover };
  }
}
