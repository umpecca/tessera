// Blinking text (SGR 5), as xterm draws it: the text of blinking cells goes
// and comes back on a timer, over its background. Ghostty's app does not
// blink text. The renderer notes blinking cells as it draws them; the timer
// runs only while there are some, each phase redraws the whole pane, and a
// full redraw with none stops it. Text stays steady when the pane's
// blinking is off (Older Mac mode) or the system asks for reduced motion.
const patch = Symbol.for("tessera.terminalTextBlink");
export const terminalTextBlinkFlag = 64;
export const terminalTextBlinkInterval = 500;

export function installTerminalTextBlink(Renderer) {
  const prototype = Renderer?.prototype;
  if (!prototype || prototype[patch] || typeof prototype.renderCellText !== "function") return;
  const renderCellText = prototype.renderCellText;
  prototype.renderCellText = function renderTesseraBlinkingText(cell, column, row) {
    if (cell.flags & terminalTextBlinkFlag) {
      this.tesseraBlinkSeen = true;
      if (this.tesseraBlinkHidden) return undefined;
    }
    return renderCellText.call(this, cell, column, row);
  };
  Object.defineProperty(prototype, patch, { value: true });
}

export class TerminalTextBlink {
  constructor(onToggle, { timers = globalThis, enabled = () => true, interval = terminalTextBlinkInterval } = {}) {
    this.onToggle = onToggle;
    this.timers = timers;
    this.enabled = enabled;
    this.interval = interval;
    this.hidden = false;
    this.timer = null;
  }

  // After each frame: whether blinking text was drawn, and whether every row
  // was, so that none drawn means none on screen.
  noteFrame(seen, full) {
    if (seen && this.enabled()) this.start();
    else if (full || (seen && !this.enabled())) this.stop();
  }

  start() {
    if (this.timer !== null) return;
    this.timer = this.timers.setInterval(() => {
      this.hidden = !this.hidden;
      this.onToggle();
    }, this.interval);
  }

  stop() {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    if (this.hidden) {
      this.hidden = false;
      this.onToggle();
    }
  }

  dispose() {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
  }
}
