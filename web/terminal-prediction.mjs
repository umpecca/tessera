// Predictive local echo, after mosh. Typed characters are drawn at once over
// the terminal and confirmed against the cells the server later draws; the
// real terminal state is never touched.
//
// Safety comes from epochs: any input that cannot be predicted (Enter,
// Backspace, arrows, paste) or any wrong guess starts a new epoch, and a
// prediction is shown only once its epoch has had one confirmed character.
// Where nothing echoes, such as a password prompt, nothing is ever shown.

export const predictionModes = ["auto", "always", "off"];
const showAboveMs = 20;
const hideBelowMs = 10;
const minimumJudgeMs = 250;
const maximumJudgeMs = 2000;

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
    const code = data.length === 1 ? data.charCodeAt(0) : -1;
    if (code < 0x20 || code > 0x7e || !screen.canPredict) return this.reset();
    const last = this.predictions.at(-1);
    const col = last ? last.col + 1 : screen.cursorX;
    const row = last ? last.row : screen.cursorY;
    // Predicting past the last column would mean guessing the wrap.
    if (col >= screen.cols) return this.reset();
    this.predictions.push({ col, row, code, sentAt: this.now() });
    return this.isVisible();
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
    const now = this.now();
    let confirmed = 0;
    for (const prediction of this.predictions) {
      if (!this.matches(prediction, screen)) break;
      confirmed += 1;
      this.sample(now - prediction.sentAt);
    }
    if (confirmed) {
      this.predictions.splice(0, confirmed);
      this.epochConfirmed = true;
    }
    if (this.predictions.length && now >= this.deadline(this.predictions[0])) this.reset();
    return before !== this.signature();
  }

  // signature changes exactly when what should be drawn changes.
  signature() {
    const { cells } = this.visible();
    return cells.map(cell => `${cell.col},${cell.row},${cell.char}`).join(";");
  }

  // A cell confirms a prediction once it holds the character and the real
  // cursor has moved past it, so a character that was already on screen
  // before the echo does not count.
  matches(prediction, screen) {
    const code = screen.cellAt(prediction.col, prediction.row);
    const same = code === prediction.code || (prediction.code === 0x20 && code === 0);
    return same && (screen.cursorY !== prediction.row || screen.cursorX > prediction.col);
  }

  sample(ms) {
    if (!(ms >= 0)) return;
    this.srtt = this.srtt === null ? ms : this.srtt + (ms - this.srtt) / 8;
    if (this.srtt > showAboveMs) this.showing = true;
    else if (this.srtt < hideBelowMs) this.showing = false;
  }

  deadline(prediction) {
    const judge = Math.min(maximumJudgeMs, Math.max(minimumJudgeMs, 3 * (this.srtt ?? 0)));
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

  // visible lists the predictions to draw and where the cursor should appear.
  visible() {
    if (!this.predictions.length || !this.isVisible()) return { cells: [], cursor: null };
    const cells = this.predictions.map(({ col, row, code }) => ({ col, row, char: String.fromCharCode(code) }));
    const last = cells.at(-1);
    return { cells, cursor: { col: last.col + 1, row: last.row } };
  }
}
