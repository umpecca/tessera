// The visible text of an OSC 8 hyperlink can be anything — a filename from
// `ls --hyperlink`, "click here" — so the pane shows where a link goes while
// the pointer is over it, as a browser's status bar does.
//
// ghostty-web tracks the link under the pointer: it underlines it and calls
// the link's hover(true) on entry and hover(false) on leaving.
// HyperlinkProvider's links pass their URI to set(); this keeps the one shown
// and tells listeners.
export class TerminalLinkHover {
  constructor(terminal) {
    this.terminal = terminal;
    this.uri = "";
    this.pointer = null;
    this.frame = 0;
    this.listeners = new Set();
  }

  onChange(listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  set(uri) {
    if (uri === this.uri) return;
    this.uri = uri;
    for (const listener of this.listeners) listener(uri);
  }

  notePointer(event) {
    this.pointer = event;
  }

  leave() {
    this.pointer = null;
    globalThis.cancelAnimationFrame?.(this.frame);
    this.frame = 0;
  }

  // Output and scrolling move text under a pointer that stays still, and
  // ghostty-web only looks again on the next mousemove, so the URI shown
  // could belong to a link that is no longer there. Look again at the last
  // pointer position, once per frame, while a link is shown.
  recheck() {
    if (!this.uri || !this.pointer || this.frame) return;
    const frame = globalThis.requestAnimationFrame?.(() => {
      this.frame = 0;
      if (this.pointer) this.terminal.processMouseMove(this.pointer);
    });
    this.frame = frame ?? 0;
  }

  dispose() {
    this.leave();
    this.listeners.clear();
  }
}
