// Predictive local echo, after mosh. Typed characters are drawn at once over
// the terminal and confirmed against the cells the server later draws; the
// real terminal state is never touched.
//
// Safety comes from epochs: any input that cannot be predicted (Enter,
// arrows, paste) or any wrong guess starts a new epoch, and a prediction is
// shown only once its epoch has had one confirmed character.
//
// Backspace withdraws a character that is still only predicted. Over text the
// server already echoed, it predicts an erase, but only at the end of the
// line: mid-line, the shell shifts the rest of the line left.
// Where nothing echoes, such as a password prompt, nothing is ever shown.

export const predictionModes = ["auto", "always", "off"];
const showAboveMs = 20;
const hideBelowMs = 10;
// A guess the screen contradicts is dropped at once; one merely unconfirmed
// gets this long, so a late echo on a jittery link does not make typed text
// vanish and reappear.
const minimumJudgeMs = 600;
const maximumJudgeMs = 3000;
const judgeRoundTrips = 4;

export function normalizePredictionMode(value) {
  return predictionModes.includes(value) ? value : "auto";
}

// A screen is what the engine may read of the real terminal:
// { cols, cursorX, cursorY, canPredict, cellAt(col, row) -> codepoint }.
export class TerminalPrediction {
  constructor({ mode = "auto", now = () => globalThis.performance.now() } = {}) {
    this.mode = normalizePredictionMode(mode);
    this.now = now;
    this.predictions = [];
    this.epoch = 0;
    this.epochConfirmed = false;
    this.srtt = null;
    this.showing = false;
    // Where the terminal draws its own cursor, and whether that cell is blank.
    this.realCursor = null;
  }

  setMode(mode) {
    this.mode = normalizePredictionMode(mode);
    if (this.mode === "off") return this.reset();
    return false;
  }

  // reset forgets every prediction and starts a new, unconfirmed epoch.
  // It reports whether anything visible changed.
  reset() {
    const changed = this.signature() !== "";
    this.predictions = [];
    this.epoch += 1;
    this.epochConfirmed = false;
    return changed;
  }

  // input sees each chunk of keyboard input before it is sent.
  input(data, screen) {
    if (this.mode === "off") return false;
    if (!screen.canPredict) return this.reset();
    this.noteRealCursor(screen);
    if (data === "\x7f" || data === "\b") return this.backspace(screen);
    const code = data.length === 1 ? data.charCodeAt(0) : -1;
    if (code < 0x20 || code > 0x7e) return this.reset();
    const { col, row } = this.predictedCursor(screen);
    // Predicting past the last column would mean guessing the wrap.
    if (col >= screen.cols) return this.reset();
    this.predictions.push({ col, row, code, sentAt: this.now() });
    return this.isVisible();
  }

  backspace(screen) {
    const before = this.signature();
    const last = this.predictions.at(-1);
    if (last && !last.erase) {
      // The character and this Backspace reach the server together, so the
      // line ends up as if neither was typed.
      this.predictions.pop();
      return before !== this.signature();
    }
    const cursor = this.predictedCursor(screen);
    const col = cursor.col - 1;
    if (col < 0 || !this.lineEndsAt(screen, cursor.row, cursor.col)) return this.reset();
    this.predictions.push({ col, row: cursor.row, erase: true, sentAt: this.now() });
    return before !== this.signature();
  }

  // lineEndsAt reports whether the row is blank from col onward, counting
  // cells with a pending erase as already blank.
  lineEndsAt(screen, row, col) {
    const erased = new Set(this.predictions.filter(p => p.erase && p.row === row).map(p => p.col));
    for (let x = col; x < screen.cols; x++) {
      const code = screen.cellAt(x, row);
      if (code !== 0 && code !== 0x20 && !erased.has(x)) return false;
    }
    return true;
  }

  // predictedCursor is where the cursor will be once every prediction lands.
  predictedCursor(screen) {
    const last = this.predictions.at(-1);
    if (!last) return { col: screen.cursorX, row: screen.cursorY };
    return { col: last.erase ? last.col : last.col + 1, row: last.row };
  }

  // check runs after server output is applied: confirmed predictions are
  // removed (the real character is drawn now), and wrong or late ones reset.
  check(screen) {
    if (!this.predictions.length) return false;
    const before = this.signature();
    if (!screen.canPredict) {
      this.reset();
      return before !== this.signature();
    }
    this.noteRealCursor(screen);
    const now = this.now();
    let confirmed = 0;
    for (let index = 0; index < this.predictions.length; index++) {
      const prediction = this.predictions[index];
      if (!this.matches(prediction, screen) && !this.overwritten(index, screen)) break;
      confirmed += 1;
      this.sample(now - prediction.sentAt);
    }
    if (confirmed) {
      this.predictions.splice(0, confirmed);
      this.epochConfirmed = true;
    }
    const next = this.predictions[0];
    if (next && (this.contradicted(next, screen) || now >= this.deadline(next))) this.reset();
    return before !== this.signature();
  }

  noteRealCursor(screen) {
    const code = screen.cellAt(screen.cursorX, screen.cursorY);
    this.realCursor = { col: screen.cursorX, row: screen.cursorY, blank: code === 0 || code === 0x20 };
  }

  // contradicted reports a guess the screen already shows to be wrong: the
  // cursor left its row, or passed its cell while the cell holds something
  // else. An erase cannot be told apart from a slow one, so it waits.
  contradicted(prediction, screen) {
    if (screen.cursorY !== prediction.row) return true;
    return !prediction.erase && screen.cursorX > prediction.col && !this.matches(prediction, screen);
  }

  // signature changes exactly when what should be drawn changes.
  signature() {
    const { cells, cover } = this.visible();
    return cells.map(cell => `${cell.col},${cell.row},${cell.char}`).join(";") + (cover ? `|${cover.col},${cover.row}` : "");
  }

  // A cell confirms a prediction once it holds the character and the real
  // cursor has moved past it, so a character that was already on screen
  // before the echo does not count.
  matches(prediction, screen) {
    const code = screen.cellAt(prediction.col, prediction.row);
    if (prediction.erase) {
      // Erased, and the real cursor has stepped back onto the cell.
      return (code === 0 || code === 0x20) && screen.cursorY === prediction.row && screen.cursorX <= prediction.col;
    }
    const same = code === prediction.code || (prediction.code === 0x20 && code === 0);
    return same && (screen.cursorY !== prediction.row || screen.cursorX > prediction.col);
  }

  // An erase can be overwritten by the next character before any check sees
  // the blank cell, when both echoes arrive together. A later confirmed
  // prediction on the same cell proves the erase happened.
  overwritten(index, screen) {
    const erase = this.predictions[index];
    if (!erase.erase) return false;
    for (let later = index + 1; later < this.predictions.length; later++) {
      const prediction = this.predictions[later];
      if (prediction.col === erase.col && prediction.row === erase.row && !prediction.erase) {
        return this.matches(prediction, screen);
      }
    }
    return false;
  }

  sample(ms) {
    if (!(ms >= 0)) return;
    this.srtt = this.srtt === null ? ms : this.srtt + (ms - this.srtt) / 8;
    if (this.srtt > showAboveMs) this.showing = true;
    else if (this.srtt < hideBelowMs) this.showing = false;
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

  // visible lists the predictions to draw, where the cursor should appear,
  // and the real cursor's cell to blank when no prediction covers it (after
  // an erase), so only one cursor shows.
  visible() {
    if (!this.predictions.length || !this.isVisible()) return { cells: [], cursor: null, cover: null };
    // An erase draws as an empty cell; a later character on it draws over it.
    const cells = this.predictions.map(({ col, row, code, erase }) => ({ col, row, char: erase ? "" : String.fromCharCode(code) }));
    const last = this.predictions.at(-1);
    const cursor = { col: last.erase ? last.col : last.col + 1, row: last.row };
    const real = this.realCursor;
    const covered = !real || cells.some(cell => cell.col === real.col && cell.row === real.row)
      || (real.col === cursor.col && real.row === cursor.row);
    return { cells, cursor, cover: !covered && real.blank ? { col: real.col, row: real.row } : null };
  }
}
