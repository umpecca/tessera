// Find in a terminal's scrollback: a bar in the top-right corner of the
// window. Typing searches as you go; Enter moves to the next older match and
// Shift+Enter to the next newer one (the newest is selected first, as the
// latest output is usually what you're after); Escape closes the bar and
// puts the keyboard back in the terminal. The search itself is the
// terminal's (terminal-entry.js search()).

export const terminalFindTypingDelayMs = 80;

// What a key does for find: "open", "older", "newer" or null. Command+F,
// Command+G and Command+Shift+G on an Apple keyboard; elsewhere
// Ctrl+Shift+F, since Ctrl+F belongs to the shell, and F3 and Shift+F3.
export function terminalFindShortcut(event, { appleKeyboard = false } = {}) {
  if (!event || event.altKey) return null;
  const key = event.key?.length === 1 ? event.key.toLowerCase() : event.key;
  if (appleKeyboard) {
    if (!event.metaKey || event.ctrlKey) return null;
    if (key === "f" && !event.shiftKey) return "open";
    if (key === "g") return event.shiftKey ? "newer" : "older";
    return null;
  }
  if (event.metaKey) return null;
  if (event.ctrlKey && event.shiftKey && key === "f") return "open";
  if (!event.ctrlKey && key === "F3") return event.shiftKey ? "newer" : "older";
  return null;
}

// "3 of 12", counted from the oldest, for results whose selected index
// counts from the newest.
export function terminalFindStatus(results) {
  if (!results) return "";
  if (!results.count) return "No matches";
  if (results.selected < 0) return `${results.count} ${results.count === 1 ? "match" : "matches"}`;
  return `${results.count - results.selected} of ${results.count}`;
}

export class TerminalFindBar {
  constructor({ term, container, onClose = () => {}, schedule = (callback, ms) => setTimeout(callback, ms), cancel = (id) => clearTimeout(id) }) {
    Object.assign(this, { term, onClose, schedule, cancel });
    this.timer = null;
    this.element = document.createElement("div");
    this.element.className = "terminal-find";
    this.element.hidden = true;
    this.element.setAttribute("role", "search");
    this.input = document.createElement("input");
    this.input.type = "search";
    this.input.className = "terminal-find-input";
    this.input.placeholder = "Find";
    this.input.setAttribute("aria-label", "Find in terminal");
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.setAttribute("autocapitalize", "off");
    this.input.setAttribute("autocorrect", "off");
    this.input.setAttribute("writingsuggestions", "false");
    this.status = document.createElement("span");
    this.status.className = "terminal-find-status";
    this.status.setAttribute("aria-live", "polite");
    const button = (text, label, run) => {
      const node = document.createElement("button");
      node.type = "button";
      node.className = "terminal-find-button";
      node.textContent = text;
      node.title = label;
      node.setAttribute("aria-label", label);
      // Keep the keyboard in the input while clicking through matches.
      node.addEventListener("pointerdown", event => event.preventDefault());
      node.addEventListener("click", run);
      return node;
    };
    this.olderButton = button("↑", "Older match (Enter)", () => this.select(true));
    this.newerButton = button("↓", "Newer match (Shift+Enter)", () => this.select(false));
    this.closeButton = button("×", "Close (Escape)", () => this.close());
    this.element.append(this.input, this.status, this.olderButton, this.newerButton, this.closeButton);
    container.append(this.element);

    this.input.addEventListener("input", () => {
      if (this.timer !== null) this.cancel(this.timer);
      this.timer = this.schedule(() => { this.timer = null; this.term.search(this.input.value); }, terminalFindTypingDelayMs);
    });
    this.input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        this.flush();
        this.select(!event.shiftKey);
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
      // Keys typed here are the input's, not the terminal's or the page's.
      event.stopPropagation();
    });
    this.subscription = term.onSearchChange(results => this.show(results));
    this.show(null);
  }

  get isOpen() {
    return !this.element.hidden;
  }

  // Opens the bar and selects its text; text (a single-line selection, say)
  // replaces it and is searched at once.
  open(text = "") {
    this.element.hidden = false;
    if (text && text !== this.input.value) {
      this.input.value = text;
      this.flush(true);
    } else if (this.input.value && !this.term.searchResults) {
      this.flush(true);
    }
    this.input.focus({ preventScroll: true });
    this.input.select();
  }

  // Runs a search the typing delay is still holding back.
  flush(force = false) {
    if (this.timer === null && !force) return;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.term.search(this.input.value);
  }

  select(older) {
    if (!this.term.searchResults) this.flush(true);
    else this.term.searchSelect(older);
  }

  show(results) {
    this.status.textContent = terminalFindStatus(results);
    const selected = results?.selected ?? -1;
    this.olderButton.disabled = !results?.count || selected >= results.count - 1;
    this.newerButton.disabled = !results?.count || selected <= 0;
    this.element.classList.toggle("is-empty", Boolean(results && !results.count));
  }

  close() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    const wasOpen = this.isOpen;
    this.element.hidden = true;
    this.term.search("");
    if (wasOpen) this.onClose();
  }

  dispose() {
    if (this.timer !== null) this.cancel(this.timer);
    this.subscription?.dispose();
    this.element.remove();
  }
}
