// Cursor blinking only needs a frame when the cursor changes, not a permanent
// animation loop. Pause the timer as well as rendering for hidden terminals.
export class TerminalCursorBlink {
  constructor(render, timers = globalThis) {
    this.render = render;
    this.timers = timers;
    this.active = false;
    this.visible = true;
    this.cursorVisible = false;
    this.timer = null;
  }

  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    this.restart();
  }

  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    this.restart();
  }

  restart() {
    this.dispose();
    this.cursorVisible = this.active;
    this.render(this.cursorVisible);
    if (this.active && this.visible) {
      this.timer = this.timers.setInterval(() => {
        this.cursorVisible = !this.cursorVisible;
        this.render(this.cursorVisible);
      }, 530);
    }
  }

  dispose() {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
  }
}
