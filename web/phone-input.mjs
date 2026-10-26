// Typing into a terminal from a phone: a compose field with the phone's own
// dictation and correction that sends whole lines, a row of the keys a phone
// keyboard lacks, one-tap answers when a program is waiting, a sheet of
// recent commands and saved snippets, and images from the phone, kept on the
// host with their path put in the field for a program such as Claude Code. Keys go to the terminal as key events,
// so cursor modes and the Kitty keyboard protocol apply as for a keyboard.

export const phoneDraftStoragePrefix = "tessera.phone-draft.v1:";
const longPressMs = 500;
const awaitingAfterSeconds = 3;
const maximumComposeHeight = 132;
const attachmentNoticeMs = 10000;

// The field's text with path inserted at the cursor, set apart by spaces,
// and where the cursor goes after it.
export function insertAttachmentPath(value, start, end, path) {
  const before = value.slice(0, start), after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && /^\s/.test(after) ? "" : " ";
  const text = `${before}${lead}${path}${trail}`;
  return { value: text + after, cursor: text.length };
}

// The field's text without one inserted path and the space put after it.
export function removeAttachmentPath(value, path) {
  const at = value.indexOf(path);
  if (at < 0) return value;
  let start = at, end = at + path.length;
  if (value[end] === " ") end += 1;
  // At the end of the text, the space put before it goes too.
  if (value[start - 1] === " " && !/\S/.test(value.slice(end))) start -= 1;
  return value.slice(0, start) + value.slice(end);
}

const key = (label, init, name = label) => ({ label, name, init });
export const phoneKeys = Object.freeze([
  key("Esc", { key: "Escape", code: "Escape" }, "Escape"),
  key("Tab", { key: "Tab", code: "Tab" }),
  key("⇧Tab", { key: "Tab", code: "Tab", shiftKey: true }, "Shift+Tab"),
  { label: "Ctrl", name: "Control (applies to the next key)", sticky: true },
  key("↑", { key: "ArrowUp", code: "ArrowUp" }, "Up"),
  key("↓", { key: "ArrowDown", code: "ArrowDown" }, "Down"),
  key("←", { key: "ArrowLeft", code: "ArrowLeft" }, "Left"),
  key("→", { key: "ArrowRight", code: "ArrowRight" }, "Right"),
  key("^C", { key: "c", code: "KeyC", ctrlKey: true }, "Control+C"),
  key("^D", { key: "d", code: "KeyD", ctrlKey: true }, "Control+D"),
  key("|", { key: "|", code: "Backslash", shiftKey: true }, "Pipe"),
  key("~", { key: "~", code: "Backquote", shiftKey: true }, "Tilde"),
  key("/", { key: "/", code: "Slash" }, "Slash"),
  key("-", { key: "-", code: "Minus" }, "Minus"),
  key("⏎", { key: "Enter", code: "Enter" }, "Enter"),
]);

export const phoneReplies = Object.freeze([
  key("1", { key: "1", code: "Digit1" }),
  key("2", { key: "2", code: "Digit2" }),
  key("3", { key: "3", code: "Digit3" }),
  key("y", { key: "y", code: "KeyY" }),
  key("n", { key: "n", code: "KeyN" }),
  key("⏎", { key: "Enter", code: "Enter" }, "Enter"),
  key("Esc", { key: "Escape", code: "Escape" }, "Escape"),
]);

const punctuationCodes = {
  " ": "Space", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash",
  ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", "`": "Backquote",
};

// The key event for one typed character, as a US keyboard would send it.
// Used for a character typed while Ctrl is held down on the key row.
export function characterKeyInit(character, { ctrl = false } = {}) {
  if (typeof character !== "string" || [...character].length !== 1) return null;
  let code = "";
  if (/^[a-z]$/i.test(character)) code = `Key${character.toUpperCase()}`;
  else if (/^[0-9]$/.test(character)) code = `Digit${character}`;
  else code = punctuationCodes[character] || "";
  if (!code) return null;
  const shiftKey = /^[A-Z]$/.test(character);
  return { key: ctrl ? character.toLowerCase() : character, code, ctrlKey: ctrl, ...(shiftKey && !ctrl ? { shiftKey } : {}) };
}

// The key event a key-row key sends, with Ctrl added when it is held.
export function phoneKeyInit(definition, { ctrl = false } = {}) {
  if (!definition?.init) return null;
  const init = { ...definition.init };
  if (ctrl) {
    init.ctrlKey = true;
    if (init.key.length === 1) init.key = init.key.toLowerCase();
  }
  return init;
}

// Whether a program in the terminal looks like it is waiting for an answer:
// it rang or notified when the phone opened the terminal, or a command is
// running and has printed nothing for a few seconds (as Claude Code does
// while it asks for permission).
export function terminalAwaitsReply(summary, elapsedSeconds = 0, alerted = false) {
  if (alerted) return true;
  if (!summary?.running || summary.exited || !(summary.outputSecondsAgo >= 0)) return false;
  return summary.outputSecondsAgo + Math.max(0, elapsedSeconds) >= awaitingAfterSeconds;
}

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(document, className, label, name) {
  const node = element(document, "button", className, label);
  node.type = "button";
  if (name && name !== label) node.setAttribute("aria-label", name);
  // Buttons below a focused field would take the focus and close the phone's
  // keyboard; the field keeps it.
  node.addEventListener("pointerdown", (event) => event.preventDefault());
  return node;
}

// The input area under an open terminal. The page supplies what acts on the
// terminal and the account:
//   sendText(paneID, text, { enter })   paste text, then Enter if asked
//   sendKey(paneID, init)               a key event for the terminal
//   typeDirectly(paneID)                focus the terminal itself
//   loadSnippets(), saveSnippets(doc)   the account's snippets
//   attachFile(file)                    keep a file on the host: { path }
//   pasteImage(paneID, file)            paste an image into the program
//   storage                             { get(key), set(key, value), remove(key) }
export class PhoneInput {
  constructor(document, options) {
    this.document = document;
    this.options = options;
    this.paneID = "";
    this.ctrl = false;
    this.direct = false;
    this.forceReplies = false;
    this.recent = [];
    this.snippets = null;
    this.snippetsRevision = "";
    this.editing = null;
    this.build();
  }

  build() {
    const doc = this.document;
    this.element = element(doc, "div", "phone-input");
    this.element.hidden = true;

    this.replies = element(doc, "div", "phone-replies");
    this.replies.setAttribute("role", "group");
    this.replies.setAttribute("aria-label", "Quick replies");
    for (const definition of phoneReplies) {
      const reply = button(doc, "phone-key phone-reply", definition.label, definition.name);
      reply.addEventListener("click", () => this.sendKey(definition));
      this.replies.append(reply);
    }

    this.keys = element(doc, "div", "phone-keys");
    this.keys.setAttribute("role", "toolbar");
    this.keys.setAttribute("aria-label", "Keys");
    this.directButton = button(doc, "phone-key phone-key-mode", "Type", "Type directly into the terminal");
    this.directButton.setAttribute("aria-pressed", "false");
    this.directButton.addEventListener("click", () => this.setDirect(!this.direct));
    this.repliesButton = button(doc, "phone-key phone-key-mode", "123", "Quick replies");
    this.repliesButton.setAttribute("aria-pressed", "false");
    this.repliesButton.addEventListener("click", () => {
      this.forceReplies = !this.forceReplies;
      this.renderReplies();
    });
    this.keys.append(this.directButton, this.repliesButton);
    for (const definition of phoneKeys) {
      const node = button(doc, "phone-key", definition.label, definition.name);
      if (definition.sticky) {
        this.ctrlButton = node;
        node.setAttribute("aria-pressed", "false");
        node.addEventListener("click", () => this.setCtrl(!this.ctrl));
      } else {
        node.addEventListener("click", () => this.sendKey(definition));
      }
      this.keys.append(node);
    }

    this.compose = element(doc, "div", "phone-compose");
    this.sheetButton = button(doc, "phone-compose-button", "☰", "Recent commands and snippets");
    this.sheetButton.addEventListener("click", () => this.openSheet());
    this.picker = element(doc, "input", "phone-attach-picker");
    this.picker.type = "file";
    this.picker.accept = "image/*";
    this.picker.multiple = true;
    this.picker.hidden = true;
    this.picker.addEventListener("change", () => {
      const files = [...(this.picker.files || [])];
      this.picker.value = "";
      void this.attachFiles(files);
    });
    this.attachButton = button(doc, "phone-compose-button", "📎", "Attach a photo or image");
    this.attachButton.addEventListener("click", () => this.picker.click());
    this.field = element(doc, "textarea", "phone-compose-field");
    this.field.rows = 1;
    this.field.placeholder = "Command or message";
    this.field.setAttribute("aria-label", "Text to send to the terminal");
    this.field.setAttribute("autocapitalize", "off");
    this.field.setAttribute("enterkeyhint", "enter");
    this.field.addEventListener("input", () => {
      this.saveDraft();
      this.fitField();
    });
    this.field.addEventListener("beforeinput", (event) => this.beforeInput(event));
    // A screenshot pasted into the field becomes an attachment, as one picked
    // with the button does. Text pastes as text.
    this.field.addEventListener("paste", (event) => {
      const data = event.clipboardData;
      if (!data || data.getData?.("text/plain")) return;
      const images = [...(data.files || [])].filter((file) => file.type?.startsWith("image/"));
      if (!images.length) return;
      event.preventDefault();
      void this.attachFiles(images);
    });
    this.sendButton = button(doc, "phone-compose-button phone-send", "Send", "Send, then Enter. Hold to send without Enter.");
    this.sendButton.title = "Send, then Enter. Hold to send without Enter.";
    this.sendButton.addEventListener("pointerdown", () => {
      this.longPress = false;
      clearTimeout(this.longPressTimer);
      this.longPressTimer = setTimeout(() => {
        this.longPress = true;
        this.send({ enter: false });
      }, longPressMs);
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
      this.sendButton.addEventListener(type, () => clearTimeout(this.longPressTimer));
    }
    this.sendButton.addEventListener("click", () => {
      if (this.longPress) {
        this.longPress = false;
        return;
      }
      this.send({ enter: true });
    });
    this.compose.append(this.sheetButton, this.attachButton, this.picker, this.field, this.sendButton);

    this.notice = element(doc, "div", "phone-input-notice");
    this.notice.hidden = true;
    this.notice.setAttribute("role", "status");
    this.noticeText = element(doc, "span", "phone-input-notice-text");
    this.noticeAction = button(doc, "phone-text-button phone-input-notice-action", "");
    this.noticeAction.hidden = true;
    this.noticeAction.addEventListener("click", () => {
      const run = this.noticeRun;
      this.noticeRun = null;
      this.noticeAction.hidden = true;
      run?.();
    });
    this.notice.append(this.noticeText, this.noticeAction);

    this.sheet = element(doc, "div", "phone-sheet");
    this.sheet.hidden = true;
    this.sheet.setAttribute("role", "dialog");
    this.sheet.setAttribute("aria-label", "Recent commands and snippets");

    this.element.append(this.notice, this.replies, this.keys, this.compose, this.sheet);
  }

  attach(paneID, { alerted = false } = {}) {
    this.paneID = paneID;
    this.alerted = alerted;
    this.openedAt = Date.now();
    this.summary = null;
    this.forceReplies = false;
    this.setCtrl(false);
    this.setDirect(false, { focus: false });
    this.closeSheet();
    this.field.value = this.options.storage?.get(phoneDraftStoragePrefix + paneID) || "";
    this.fitField();
    this.element.hidden = false;
    this.renderReplies();
  }

  detach() {
    this.closeSheet();
    this.showNotice("");
    this.paneID = "";
    this.element.hidden = true;
    if (this.field === this.document.activeElement) this.field.blur();
  }

  // The open terminal's latest summary, and how long ago it arrived.
  update(summary, elapsedSeconds) {
    this.summary = summary;
    this.elapsed = elapsedSeconds;
    this.recent = Array.isArray(summary?.recentCommands) ? summary.recentCommands : [];
    // Once the terminal has printed since it was opened, the alert that was
    // waiting has been answered or was never a question.
    if (this.alerted && summary?.outputSecondsAgo >= 0 && summary.outputSecondsAgo < this.openedFor()) this.alerted = false;
    this.renderReplies();
  }

  openedFor() {
    return this.openedAt ? (Date.now() - this.openedAt) / 1000 : Infinity;
  }

  renderReplies() {
    const waiting = terminalAwaitsReply(this.summary, this.elapsed, this.alerted);
    this.replies.hidden = !(waiting || this.forceReplies);
    this.repliesButton.setAttribute("aria-pressed", String(!this.replies.hidden));
    this.element.dataset.waiting = String(waiting);
  }

  setCtrl(on) {
    this.ctrl = on;
    this.ctrlButton.setAttribute("aria-pressed", String(on));
  }

  setDirect(on, { focus = true } = {}) {
    this.direct = on;
    this.directButton.setAttribute("aria-pressed", String(on));
    this.compose.hidden = on;
    if (!focus) return;
    if (on) this.options.typeDirectly?.(this.paneID);
    else this.field.focus({ preventScroll: true });
  }

  sendKey(definition) {
    if (!this.paneID) return;
    const init = phoneKeyInit(definition, { ctrl: this.ctrl });
    this.setCtrl(false);
    if (init) this.options.sendKey(this.paneID, init);
  }

  // With Ctrl held, the next character typed is a control key for the
  // terminal (Ctrl+R, Ctrl+Z), not text for the field.
  beforeInput(event) {
    if (!this.ctrl || event.inputType !== "insertText" || typeof event.data !== "string") return;
    const init = characterKeyInit(event.data, { ctrl: true });
    if (!init) return;
    event.preventDefault();
    this.setCtrl(false);
    this.options.sendKey(this.paneID, init);
  }

  send({ enter }) {
    if (!this.paneID) return;
    const text = this.field.value;
    if (!text && !enter) return;
    this.options.sendText(this.paneID, text, { enter });
    this.showNotice("");
    this.field.value = "";
    this.options.storage?.remove(phoneDraftStoragePrefix + this.paneID);
    this.fitField();
    this.alerted = false;
    this.renderReplies();
  }

  // Keeps each image on the host and puts its path in the field. One image
  // can go to the program as a paste instead, for programs that take images
  // only from the clipboard.
  async attachFiles(files) {
    const paneID = this.paneID;
    if (!paneID || !files.length || !this.options.attachFile) return;
    const added = [];
    for (const [index, file] of files.entries()) {
      const name = file.name || "image";
      this.showNotice(files.length > 1 ? `Sending ${name} (${index + 1} of ${files.length})…` : `Sending ${name}…`, null, { keep: true });
      let path;
      try {
        ({ path } = await this.options.attachFile(file));
      } catch (error) {
        this.showNotice(`${name} wasn't sent: ${error?.message || "the host refused it"}`);
        return;
      }
      if (this.paneID !== paneID) return;
      const { value, cursor } = insertAttachmentPath(this.field.value, this.field.selectionStart ?? this.field.value.length, this.field.selectionEnd ?? this.field.value.length, path);
      this.field.value = value;
      this.field.selectionStart = this.field.selectionEnd = cursor;
      this.saveDraft();
      this.fitField();
      added.push({ file, path, name });
    }
    if (added.length === 1 && this.options.pasteImage && added[0].file.type?.startsWith("image/")) {
      const [{ file, path, name }] = added;
      this.showNotice(`Added ${name}`, { label: "Paste as image instead", run: () => void this.pasteInstead(file, path, name) });
    } else {
      this.showNotice(added.length === 1 ? `Added ${added[0].name}` : `Added ${added.length} images`);
    }
  }

  async pasteInstead(file, path, name) {
    const paneID = this.paneID;
    this.field.value = removeAttachmentPath(this.field.value, path);
    this.saveDraft();
    this.fitField();
    this.showNotice(`Pasting ${name}…`, null, { keep: true });
    try {
      await this.options.pasteImage(paneID, file);
      this.showNotice(`Pasted ${name} into the program`);
    } catch (error) {
      this.showNotice(`${name} wasn't pasted: ${error?.message || "the host clipboard is unavailable"}`);
    }
  }

  showNotice(text, action = null, { keep = false } = {}) {
    clearTimeout(this.noticeTimer);
    this.notice.hidden = !text;
    this.noticeText.textContent = text;
    this.noticeAction.hidden = !action;
    this.noticeAction.textContent = action?.label || "";
    this.noticeRun = action?.run || null;
    if (text && !keep) this.noticeTimer = setTimeout(() => this.showNotice(""), attachmentNoticeMs);
  }

  saveDraft() {
    if (!this.paneID) return;
    const key = phoneDraftStoragePrefix + this.paneID;
    if (this.field.value) this.options.storage?.set(key, this.field.value);
    else this.options.storage?.remove(key);
  }

  fitField() {
    if (!this.field.style) return;
    this.field.style.height = "auto";
    const height = Math.min(this.field.scrollHeight || 0, maximumComposeHeight);
    if (height) this.field.style.height = `${height}px`;
  }

  fill(text) {
    this.field.value = text;
    this.saveDraft();
    this.fitField();
    this.closeSheet();
    this.setDirect(false);
  }

  async openSheet() {
    this.sheet.hidden = false;
    this.editing = null;
    this.renderSheet();
    if (this.snippets === null) {
      try {
        const doc = await this.options.loadSnippets();
        this.snippets = Array.isArray(doc?.snippets) ? doc.snippets : [];
        this.snippetsRevision = doc?.revision || "";
        this.snippetsError = "";
      } catch (error) {
        this.snippetsError = error?.message || "Snippets could not be loaded.";
      }
      if (!this.sheet.hidden) this.renderSheet();
    }
  }

  closeSheet() {
    this.sheet.hidden = true;
    this.editing = null;
  }

  renderSheet() {
    const doc = this.document;
    const header = element(doc, "div", "phone-sheet-header");
    header.append(element(doc, "h2", "phone-sheet-title", this.editing ? (this.editing.id ? "Edit Snippet" : "New Snippet") : "Send Again"));
    const close = button(doc, "phone-compose-button", "Done");
    close.addEventListener("click", () => (this.editing ? this.stopEditing() : this.closeSheet()));
    header.append(close);
    if (this.editing) {
      this.sheet.replaceChildren(header, this.renderSnippetForm());
      return;
    }

    const snippets = element(doc, "section", "phone-sheet-section");
    const snippetsHeading = element(doc, "div", "phone-sheet-heading");
    snippetsHeading.append(element(doc, "h3", "", "Snippets"));
    const add = button(doc, "phone-text-button", "New…", "New snippet");
    add.addEventListener("click", () => this.startEditing({ id: "", label: "", text: this.field.value }));
    snippetsHeading.append(add);
    snippets.append(snippetsHeading);
    if (this.snippetsError) snippets.append(element(doc, "p", "phone-sheet-note", this.snippetsError));
    else if (this.snippets === null) snippets.append(element(doc, "p", "phone-sheet-note", "Loading…"));
    else if (!this.snippets.length) snippets.append(element(doc, "p", "phone-sheet-note", "Save text you send often, such as a prompt or a command. Tap New… to add one."));
    else {
      const list = element(doc, "ul", "phone-sheet-list");
      for (const snippet of this.snippets) {
        const item = element(doc, "li", "phone-sheet-item");
        const use = button(doc, "phone-sheet-use", "");
        use.append(element(doc, "span", "phone-sheet-label", snippet.label || snippet.text.split("\n")[0]));
        if (snippet.label) use.append(element(doc, "span", "phone-sheet-text", snippet.text));
        use.addEventListener("click", () => this.fill(snippet.text));
        const edit = button(doc, "phone-icon-button", "✎", `Edit ${snippet.label || "snippet"}`);
        edit.addEventListener("click", () => this.startEditing({ ...snippet }));
        item.append(use, edit);
        list.append(item);
      }
      snippets.append(list);
    }

    const recent = element(doc, "section", "phone-sheet-section");
    recent.append(element(doc, "h3", "", "Recent commands"));
    if (!this.recent.length) {
      recent.append(element(doc, "p", "phone-sheet-note", "Commands this terminal runs appear here when its shell marks its prompts."));
    } else {
      const list = element(doc, "ul", "phone-sheet-list");
      for (const line of this.recent) {
        const item = element(doc, "li", "phone-sheet-item");
        const use = button(doc, "phone-sheet-use phone-sheet-command", line);
        use.addEventListener("click", () => this.fill(line));
        item.append(use);
        list.append(item);
      }
      recent.append(list);
    }
    this.sheet.replaceChildren(header, snippets, recent);
  }

  startEditing(snippet) {
    this.editing = snippet;
    this.editError = "";
    this.renderSheet();
  }

  stopEditing() {
    this.editing = null;
    this.renderSheet();
  }

  renderSnippetForm() {
    const doc = this.document;
    const form = element(doc, "form", "phone-snippet-form");
    const nameLabel = element(doc, "label", "phone-field-label", "Name (optional)");
    const name = element(doc, "input", "phone-field");
    name.value = this.editing.label;
    name.maxLength = 80;
    nameLabel.append(name);
    const textLabel = element(doc, "label", "phone-field-label", "Text");
    const text = element(doc, "textarea", "phone-field phone-snippet-text");
    text.value = this.editing.text;
    text.rows = 5;
    text.setAttribute("autocapitalize", "off");
    textLabel.append(text);
    const error = element(doc, "p", "phone-sheet-note phone-sheet-error", this.editError || "");
    error.hidden = !this.editError;
    const actions = element(doc, "div", "phone-snippet-actions");
    const save = element(doc, "button", "phone-compose-button phone-send", "Save");
    save.type = "submit";
    actions.append(save);
    if (this.editing.id) {
      const remove = button(doc, "phone-text-button phone-danger", "Delete");
      remove.addEventListener("click", () => void this.saveSnippet(null));
      actions.append(remove);
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.saveSnippet({ label: name.value.trim(), text: text.value });
    });
    form.append(nameLabel, textLabel, error, actions);
    return form;
  }

  // Saves the edited snippet, or deletes it when given null. A save another
  // device made first is not overwritten: the newer list loads instead.
  async saveSnippet(fields) {
    const editing = this.editing;
    if (!editing || this.snippets === null) return;
    if (fields && !fields.text.trim()) {
      this.editError = "A snippet needs text.";
      this.renderSheet();
      return;
    }
    const id = editing.id || this.options.newID?.() || `snippet-${Date.now().toString(36)}`;
    if (fields) this.editing = { ...editing, ...fields };
    let next = this.snippets.filter((snippet) => snippet.id !== editing.id);
    if (fields) {
      const snippet = { id, label: fields.label, text: fields.text };
      const at = this.snippets.findIndex((candidate) => candidate.id === editing.id);
      next = at >= 0 ? [...next.slice(0, at), snippet, ...next.slice(at)] : [...next, snippet];
    }
    try {
      const saved = await this.options.saveSnippets({ revision: this.snippetsRevision, snippets: next });
      this.snippets = saved.snippets;
      this.snippetsRevision = saved.revision;
      this.editing = null;
    } catch (error) {
      if (error?.status === 409) {
        this.snippets = null;
        this.editError = "Another device changed your snippets. They have been reloaded; save again.";
        try {
          const doc = await this.options.loadSnippets();
          this.snippets = doc.snippets || [];
          this.snippetsRevision = doc.revision || "";
        } catch {
          this.snippets = [];
        }
      } else {
        this.editError = error?.message || "The snippet could not be saved.";
      }
    }
    if (!this.sheet.hidden) this.renderSheet();
  }
}
