import { newWorkspaceRevision } from "./workspace-concurrency.mjs";

export function shortcutCodeError(code, items, reserved, id) {
  if (!/^[A-Z]{2}$/.test(code)) return "Use a two-letter code, such as CE.";
  if (reserved.some(value => code === value || (value.length === 1 && code.startsWith(value)))) return "That code conflicts with a built-in command.";
  if (items.some(item => item.id !== id && item.code === code)) return "That code belongs to another shortcut.";
  return "";
}

export function duplicateShortcut(item) {
  return { ...structuredClone(item), id: newWorkspaceRevision(), name: item.name + " copy", code: "" };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, run, className = "") {
  const node = element("button", className, text);
  node.type = "button";
  node.addEventListener("click", run);
  return node;
}
function input(value = "", type = "text") {
  const node = element("input"); node.type = type;
  if (type === "checkbox") node.checked = Boolean(value); else node.value = value;
  node.autocomplete = "off"; node.spellcheck = false;
  node.setAttribute("writingsuggestions", "false");
  return node;
}
function labelled(text, control) {
  const label = element("label", "shortcut-field");
  control.setAttribute("aria-label", text);
  label.append(element("span", "", text), control); return label;
}

// Owns a single modal and its asynchronous generation. Server launch responses
// only become terminal commands while their originating user/session is current.
export class ShortcutsModal {
  constructor({ getContext, onLaunch, onSaved, onClose }) {
    Object.assign(this, { getContext, onLaunch, onSaved, onClose });
    this.items = []; this.reserved = []; this.revision = ""; this.user = "";
    this.generation = 0; this.busy = false; this.draft = null; this.dirty = false;
    this.element = element("div", "settings-modal shortcuts-modal");
    this.element.hidden = true;
    document.body.append(this.element);
    this.element.addEventListener("pointerdown", event => {
      if (event.target === this.element && !this.busy) this.close();
    });
    this.element.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); this.cancel(); }
      if (event.key === "Tab") {
        const controls = this.controls(); const index = controls.indexOf(document.activeElement);
        if (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
          event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
        }
      }
    });
    document.addEventListener("focusin", event => {
      if (!this.element.hidden && !this.element.contains(event.target)) this.controls()[0]?.focus();
    });
  }
  controls() {
    return [...this.element.querySelectorAll("button,input,select")].filter(node => !node.disabled && node.getClientRects().length);
  }
  setDocument(user, doc) {
    this.close(); this.user = user; this.items = doc.shortcuts || [];
    this.revision = doc.revision; this.reserved = doc.reservedCodes || this.reserved;
    this.draft = null; this.dirty = false; this.shell = doc.shell;
  }
  endpoint(user = this.user) { return `/api/users/${encodeURIComponent(user)}/shortcuts`; }
  async request(url, method, body) {
    const response = await fetch(url, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || `Shortcuts request failed (${response.status}).`);
      error.status = response.status; throw error;
    }
    return result;
  }
  current(context, generation) {
    const now = this.getContext();
    return generation === this.generation && context.user === now.user && context.workspaceId === now.workspaceId;
  }
  open() {
    this.generation++; this.busy = false; this.mode = "manage"; this.element.hidden = false;
    this.render(); this.controls()[0]?.focus();
  }
  close() {
    const visible = !this.element.hidden;
    this.generation++; this.busy = false; this.element.hidden = true;
    if (visible) this.onClose?.(this.element);
  }
  cancel() {
    if (this.busy) { this.close(); return; }
    if (this.mode === "invoke" && this.invocation.test) { this.mode = "manage"; this.render(); return; }
    this.close();
  }
  showError(error) {
    if (this.error) this.error.textContent = error.message || String(error);
  }
  setBusy(value) {
    this.busy = value;
    this.element.querySelectorAll("button,input,select").forEach(node => { if (value) { node.dataset.shortcutDisabled = String(node.disabled); node.disabled = true; }
      else { node.disabled = node.dataset.shortcutDisabled === "true"; delete node.dataset.shortcutDisabled; } });
  }
  edit(item) {
    if (this.dirty) { this.showError("Save or cancel your current edits first."); return; }
    this.draft = structuredClone(item); this.render();
    this.element.querySelector('[name="shortcut-name"]')?.focus();
  }
  validateDraft() {
    const s = this.draft;
    if (!s?.name.trim() || !s.command.trim()) throw new Error("Name and base command are required.");
    const error = shortcutCodeError(s.code, this.items, this.reserved, s.id);
    if (error) throw new Error(error);
    for (const field of s.fields) {
      if (!field.label.trim()) throw new Error("Each input needs a label.");
      if (field.switch && !/^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$/.test(field.switch)) throw new Error("Use a switch like --file or -f, or leave it blank for a positional argument.");
      if (field.type === "boolean" && !field.switch) throw new Error("Boolean inputs need a switch.");
    }
    return s;
  }
  async save(items) {
    const context = this.getContext(), generation = this.generation;
    this.setBusy(true); this.showError("");
    try {
      const doc = await this.request(this.endpoint(context.user), "PUT", { revision: this.revision, shortcuts: items });
      if (!this.current(context, generation)) return;
      this.items = doc.shortcuts; this.revision = doc.revision;
      this.draft = null; this.dirty = false; this.busy = false;
      this.onSaved?.(); this.render();
    } catch (error) {
      if (!this.current(context, generation)) return;
      this.setBusy(false); this.showError(error);
      if (error.status === 409) this.reloadButton.hidden = false;
    }
  }
  async reload() {
    const context = this.getContext(), generation = this.generation;
    if (this.dirty && !window.confirm("Reload shortcuts and discard unsaved edits?")) return;
    this.setBusy(true);
    try {
      const doc = await this.request(this.endpoint(context.user), "GET");
      if (!this.current(context, generation)) return;
      this.items = doc.shortcuts; this.revision = doc.revision; this.reserved = doc.reservedCodes;
      this.draft = null; this.dirty = false; this.busy = false; this.onSaved?.(); this.render();
    } catch (error) { if (this.current(context, generation)) { this.setBusy(false); this.showError(error); } }
  }
  invoke(shortcut, { test = false } = {}) {
    if (this.busy) return;
    this.generation++; this.invocation = { shortcut: structuredClone(shortcut), test, context: this.getContext() };
    if (!shortcut.fields.length) { this.launch({}); return; }
    this.mode = "invoke"; this.element.hidden = false; this.render();
    this.element.querySelector("input")?.focus();
  }
  async launch(values) {
    const { shortcut, test, context } = this.invocation, generation = this.generation;
    if (this.busy) return;
    this.invocation.values = values;
    this.setBusy(true); this.showError("");
    try {
      const url = this.endpoint(context.user) + (test ? "/test" : `/${encodeURIComponent(shortcut.id)}/launch`);
      const result = await this.request(url, "POST", { workspaceId: context.workspaceId, cwd: context.cwd || "", values, ...(test ? { shortcut } : {}) });
      if (!this.current(context, generation)) return;
      this.close(); this.onLaunch(result);
    } catch (error) {
      if (!this.current(context, generation)) return;
      this.busy = false;
      // Even an immediate launcher has a visible place to show host failures.
      this.mode = "invoke"; this.element.hidden = false; this.render(); this.showError(error);
    }
  }
  render() {
    this.element.replaceChildren();
    const panel = element("section", "settings-panel shortcuts-panel");
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "shortcuts-title");
    const title = element("div", "settings-title", this.mode === "invoke" ? `${this.invocation.test ? "Test" : "Launch"}: ${this.invocation.shortcut.name}` : "Shortcuts");
    title.id = "shortcuts-title";
    const close = button("×", () => this.cancel(), "shortcuts-close"); close.setAttribute("aria-label", "Close shortcuts"); title.append(close);
    const content = element("div", "settings-content shortcuts-content");
    this.error = element("div", "session-action-error"); this.error.setAttribute("role", "alert");
    panel.append(title, content); this.element.append(panel);
    if (this.mode === "invoke") this.renderInvocation(content); else this.renderManager(content);
    content.append(this.error);
  }
  renderManager(content) {
    content.append(element("p", "shortcut-description", "Saved for this user across sessions. Each shortcut opens a new terminal."));
    const toolbar = element("div", "shortcut-actions");
    toolbar.append(button("Add shortcut", () => this.edit({ id: newWorkspaceRevision(), name: "", code: "", command: "", cwd: "", fields: [] })));
    this.reloadButton = button("Reload shortcuts", () => this.reload()); toolbar.append(this.reloadButton);
    content.append(toolbar);
    const list = element("div", "shortcuts-list");
    if (!this.items.length) list.append(element("p", "shortcut-description", "No shortcuts yet. Add an Editor shortcut with code CE and your terminal editor command."));
    for (const item of this.items) {
      const row = element("div", "shortcut-row"); row.dataset.shortcutId = item.id;
      const edit = button(`${item.code} · ${item.name}`, () => this.edit(item), "shortcut-name");
      edit.title = item.command;
      row.append(edit, button("Run", () => this.invoke(item)), button("Duplicate", () => this.edit(duplicateShortcut(item))), button("Delete", () => {
        if (this.dirty) { this.showError("Save or cancel your current edits first."); return; }
        if (window.confirm(`Delete shortcut “${item.name}”?`)) void this.save(this.items.filter(candidate => candidate.id !== item.id));
      }));
      list.append(row);
    }
    content.append(list);
    if (!this.draft) return;
    const s = this.draft;
    const form = element("form", "shortcut-editor");
    const metadata = element("div", "shortcut-metadata");
    for (const [key, label, placeholder, max] of [["name","Name","Editor",80],["code","Palette code","CE",2],["command","Base command","fresh",4096],["cwd","Working directory","Current pane directory (host default if none)",4096]]) {
      const control = input(s[key]); control.name = `shortcut-${key}`; control.placeholder = placeholder; control.maxLength = max;
      if (key === "name" || key === "command" || key === "code") control.required = true;
      control.addEventListener("input", () => { s[key] = key === "code" ? control.value.toUpperCase().trim() : control.value; if (key === "code") control.value = s[key]; this.dirty = true; });
      metadata.append(labelled(label, control));
    }
    form.append(metadata, element("p", "shortcut-description", "The base command is shell syntax. For an executable path with spaces, quote it; in PowerShell use & before the quoted path. Empty optional text omits its switch. A blank switch creates a positional argument."));
    const fields = element("div", "shortcut-fields");
    for (const [index, field] of s.fields.entries()) fields.append(this.renderField(field, index));
    form.append(fields, button("Add input", () => {
      if (s.fields.length >= 32) { this.showError("At most 32 inputs are allowed."); return; }
      s.fields.push({ id: newWorkspaceRevision(), label: "", type: "text", switch: "", default: "", checked: false, required: false });
      this.dirty = true; this.render();
      this.element.querySelectorAll('.shortcut-input-label').item(s.fields.length - 1)?.focus();
    }));
    const actions = element("div", "shortcut-actions");
    const save = button("Save shortcut", () => {}); save.type = "submit";
    actions.append(save, button("Test shortcut", () => {
      try { this.invoke(this.validateDraft(), { test: true }); } catch (error) { this.showError(error); }
    }), button("Cancel edits", () => { this.draft = null; this.dirty = false; this.render(); }));
    form.append(actions);
    form.addEventListener("submit", event => {
      event.preventDefault();
      try {
        const item = structuredClone(this.validateDraft());
        const items = this.items.some(other => other.id === item.id) ? this.items.map(other => other.id === item.id ? item : other) : [...this.items, item];
        void this.save(items);
      } catch (error) { this.showError(error); }
    });
    content.append(form);
  }
  renderField(field, index) {
    const row = element("fieldset", "shortcut-input-row"); row.append(element("legend", "", `Input ${index + 1}`));
    const label = input(field.label); label.className = "shortcut-input-label"; label.maxLength = 80;
    const type = element("select");
    for (const [value, text] of [["text","Text / positional"],["boolean","Boolean switch"]]) { const option = element("option", "", text); option.value = value; type.append(option); }
    type.value = field.type;
    type.addEventListener("change", () => { field.type = type.value; field.default = ""; field.checked = false; field.required = false; this.dirty = true; this.render(); });
    const flag = input(field.switch); flag.placeholder = "--file, -f, or empty";
    for (const [control, key] of [[label,"label"],[flag,"switch"]]) control.addEventListener("input", () => { field[key] = control.value; this.dirty = true; });
    row.append(labelled("Input label", label), labelled("Input type", type), labelled("CLI switch", flag));
    if (field.type === "boolean") {
      const checked = input(field.checked, "checkbox"); checked.addEventListener("change", () => { field.checked = checked.checked; this.dirty = true; });
      row.append(labelled("Checked by default", checked));
    } else {
      const value = input(field.default); value.maxLength = 4096;
      value.addEventListener("input", () => { field.default = value.value; this.dirty = true; });
      const required = input(field.required, "checkbox"); required.addEventListener("change", () => { field.required = required.checked; this.dirty = true; });
      row.append(labelled("Default value", value), labelled("Required", required));
    }
    const order = element("div", "shortcut-actions");
    for (const [text, delta] of [["Move input up",-1],["Move input down",1]]) {
      const move = button(text, () => { const target = index + delta; [this.draft.fields[index],this.draft.fields[target]] = [this.draft.fields[target],this.draft.fields[index]]; this.dirty = true; this.render(); });
      move.disabled = index + delta < 0 || index + delta >= this.draft.fields.length; order.append(move);
    }
    order.append(button("Remove input", () => { this.draft.fields.splice(index,1); this.dirty = true; this.render(); }));
    row.append(order); return row;
  }
  renderInvocation(content) {
    const { shortcut, context } = this.invocation;
    content.append(element("p", "shortcut-description", `Command: ${shortcut.command}`), element("p", "shortcut-description", `Directory: ${shortcut.cwd || context.cwd || "host default"}`));
    const form = element("form", "shortcut-invocation"); const values = new Map();
    for (const field of shortcut.fields) {
      const value = this.invocation.values && Object.hasOwn(this.invocation.values, field.id) ? this.invocation.values[field.id] : field.type === "boolean" ? field.checked : field.default;
      const control = input(value, field.type === "boolean" ? "checkbox" : "text");
      control.required = field.type === "text" && field.required; control.maxLength = 4096;
      control.name = field.id; values.set(field.id, control);
      const label = labelled(field.label + (field.required ? " (required)" : " (optional)"), control);
      label.append(element("small", "", field.switch || "Positional argument")); form.append(label);
    }
    const actions = element("div", "shortcut-actions"); const launch = button("Launch", () => {}); launch.type = "submit";
    actions.append(launch, button("Cancel", () => this.cancel())); form.append(actions);
    form.addEventListener("submit", event => { event.preventDefault(); const result = {}; for (const [id, control] of values) result[id] = control.type === "checkbox" ? control.checked : control.value; void this.launch(result); });
    content.append(form);
  }
}
