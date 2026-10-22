// Save Clipboard to File: a dialog that saves what is on the clipboard (text,
// images, or files pasted or dropped into it) to a folder on the host. The
// browser's clipboard API offers only text and images, so files copied in
// Finder or the Files app come in through a paste (Cmd+V) or a drop instead.
// Each item is posted to /api/host/files, which stages it beside the
// destination and asks before replacing an existing file.

export const hostFilesEndpoint = "/api/host/files";

const extensions = {
  "text/plain": "txt",
  "text/html": "html",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export function defaultSaveName(type) {
  return `clipboard.${extensions[type] || "bin"}`;
}

// Gives repeated names a number before the extension: clipboard-2.png.
export function uniqueSaveNames(names) {
  const seen = new Set();
  return names.map((name) => {
    let candidate = name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    for (let count = 2; seen.has(candidate); count++) candidate = `${stem}-${count}${extension}`;
    seen.add(candidate);
    return candidate;
  });
}

function entry(blob, name, kind) {
  return { blob, name, kind, include: true };
}

export function textSaveEntry(text) {
  return entry(new Blob([text], { type: "text/plain" }), defaultSaveName("text/plain"), "text");
}

// Entries from navigator.clipboard.read(): one image per item when it has
// one, its text otherwise. HTML is left out when the item has plain text too.
export async function clipboardSaveEntries(items) {
  const entries = [];
  for (const item of items || []) {
    const types = item.types || [];
    const image = types.find(type => type.startsWith("image/"));
    if (image) {
      entries.push(entry(await item.getType(image), defaultSaveName(image), "image"));
    } else if (types.includes("text/plain")) {
      const blob = await item.getType("text/plain");
      if (blob.size) entries.push(entry(blob, defaultSaveName("text/plain"), "text"));
    } else if (types.includes("text/html")) {
      entries.push(entry(await item.getType("text/html"), defaultSaveName("text/html"), "text"));
    }
  }
  return entries;
}

// Entries from a paste or drop: its files under their own names, or else its
// text.
export function transferSaveEntries(dataTransfer) {
  const files = [...(dataTransfer?.files || [])];
  if (files.length) {
    return files.map(file => entry(file, file.name || defaultSaveName(file.type), file.type.startsWith("image/") ? "image" : "file"));
  }
  const text = dataTransfer?.getData?.("text/plain") || "";
  return text ? [textSaveEntry(text)] : [];
}

export function hostFileURL(directory, name, overwrite = false) {
  const query = new URLSearchParams({ directory, name });
  if (overwrite) query.set("overwrite", "1");
  return `${hostFilesEndpoint}?${query}`;
}

export function describeSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Saves each entry in turn. A name that exists already is replaced only when
// confirmReplace(name) agrees; otherwise it is skipped. Returns
// { saved: [paths], skipped: [names] }, or throws on the first failure.
export async function saveEntries(entries, directory, { fetchImpl = globalThis.fetch, confirmReplace = async () => false, onProgress = () => {} } = {}) {
  const saved = [];
  const skipped = [];
  for (const [index, item] of entries.entries()) {
    onProgress(`Saving ${item.name} (${index + 1} of ${entries.length})…`);
    let response = await post(fetchImpl, directory, item, false);
    if (response.status === 409) {
      if (!await confirmReplace(item.name)) {
        skipped.push(item.name);
        continue;
      }
      response = await post(fetchImpl, directory, item, true);
    }
    let body = {};
    try { body = await response.json(); } catch { /* A proxy error page. */ }
    if (!response.ok) throw new Error(`${item.name}: ${body.error || `the server answered ${response.status}`}`);
    saved.push(body.path || item.name);
  }
  return { saved, skipped };
}

function post(fetchImpl, directory, item, overwrite) {
  return fetchImpl(hostFileURL(directory, item.name, overwrite), {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: item.blob,
    credentials: "same-origin",
  });
}

// Deletes files a save wrote. The server deletes only files it saved and
// that are unchanged since; it returns { deleted: [paths], kept: [{ path,
// reason }] }.
export async function deleteSavedFiles(paths, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${hostFilesEndpoint}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `The server answered ${response.status}`);
  return { deleted: body.deleted || [], kept: body.kept || [] };
}

// The last save, kept per browser so the delete command survives a reload.
// Storage can be unavailable; then it lasts until the page closes.
export class LastClipboardSave {
  constructor({ storage = globalThis.localStorage, key = "tessera.last-clipboard-save.v1" } = {}) {
    Object.assign(this, { storage, key });
    this.value = null;
    try { this.value = JSON.parse(storage?.getItem(key) || "null"); } catch { this.value = null; }
    if (!Array.isArray(this.value?.paths) || !this.value.paths.length) this.value = null;
  }

  get paths() { return this.value?.paths || []; }

  set(paths, directory) {
    this.value = paths.length ? { paths, directory } : null;
    try {
      if (this.value) this.storage?.setItem(this.key, JSON.stringify(this.value));
      else this.storage?.removeItem(this.key);
    } catch { /* Kept in memory only. */ }
  }
}

export class SaveClipboardDialog {
  // readClipboard() resolves to entries and must be called while the
  // keystroke or click that opened the dialog still counts as a user action.
  constructor({ readClipboard, fetchImpl = (...args) => globalThis.fetch(...args), confirmReplace, onSaved = () => {}, onClose = () => {}, pasteKey = "Cmd+V" }) {
    Object.assign(this, { readClipboard, fetchImpl, confirmReplace, onSaved, onClose, pasteKey });
    this.entries = [];
    this.locations = [];
    this.current = "";
    this.saving = false;
    this.listing = 0;

    this.element = document.createElement("div");
    this.element.className = "settings-modal save-clipboard-modal";
    this.element.hidden = true;
    this.element.addEventListener("pointerdown", (event) => { if (event.target === this.element) this.close(); });

    const panel = document.createElement("section");
    this.panel = panel;
    panel.className = "settings-panel save-clipboard-panel";
    panel.tabIndex = -1;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "save-clipboard-title");
    const titleBar = document.createElement("div");
    titleBar.className = "settings-title";
    const title = document.createElement("h2");
    title.id = "save-clipboard-title";
    title.textContent = "Save Clipboard to File";
    titleBar.append(title);

    const content = document.createElement("div");
    content.className = "settings-content save-clipboard-content";
    this.items = document.createElement("div");
    this.items.className = "save-clipboard-items";
    this.hint = document.createElement("p");
    this.hint.className = "save-clipboard-hint";
    this.hint.textContent = `Press ${pasteKey} here or drop files to add them; files copied in Finder or the Files app arrive this way.`;

    const destinationLabel = document.createElement("label");
    destinationLabel.htmlFor = "save-clipboard-directory";
    destinationLabel.textContent = "Save to folder";
    this.directory = document.createElement("input");
    this.directory.id = "save-clipboard-directory";
    this.directory.className = "rename-window-input";
    this.directory.type = "text";
    this.directory.spellcheck = false;
    this.directory.autocomplete = "off";
    this.directory.setAttribute("autocapitalize", "off");
    this.directory.setAttribute("autocorrect", "off");
    this.directory.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void this.browse(this.directory.value);
    });
    this.directory.addEventListener("change", () => void this.browse(this.directory.value));
    this.presets = document.createElement("div");
    this.presets.className = "save-clipboard-presets";
    this.folders = document.createElement("div");
    this.folders.className = "directory-browser-list save-clipboard-folders";

    this.status = document.createElement("p");
    this.status.className = "save-clipboard-status";
    this.status.setAttribute("role", "status");
    const actions = document.createElement("div");
    actions.className = "rename-window-actions";
    const cancel = this.button("Cancel", () => this.close());
    this.saveButton = this.button("Save", () => void this.save());
    actions.append(cancel, this.saveButton);

    content.append(this.items, this.hint, destinationLabel, this.directory, this.presets, this.folders, this.status, actions);
    panel.append(titleBar, content);
    this.element.append(panel);

    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.save();
      }
    });
    // Pasting text into a name or the folder field edits that field. Files,
    // or a paste anywhere else in the dialog, add to what will be saved.
    panel.addEventListener("paste", (event) => {
      const fromField = event.target?.tagName === "INPUT" && event.target.type === "text";
      if (fromField && !event.clipboardData?.files?.length) return;
      event.preventDefault();
      this.add(transferSaveEntries(event.clipboardData));
    });
    panel.addEventListener("dragover", (event) => {
      if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    panel.addEventListener("drop", (event) => {
      event.preventDefault();
      this.add(transferSaveEntries(event.dataTransfer));
    });
  }

  button(text, run) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "settings-background-button";
    node.textContent = text;
    node.addEventListener("click", run);
    return node;
  }

  // current is the active terminal's folder, or "" when it has none.
  open({ current = "" } = {}) {
    this.entries = [];
    this.current = current;
    this.saving = false;
    this.setStatus("Reading the clipboard…");
    this.renderItems();
    this.element.hidden = false;
    // Start the read before anything awaits, while this is still a user action.
    let reading;
    try { reading = Promise.resolve(this.readClipboard()); } catch (error) { reading = Promise.reject(error); }
    void this.browse(current, { fallback: true });
    this.panel.focus();
    reading.then((entries) => {
      if (this.element.hidden) return;
      this.add(entries);
      this.setStatus(this.entries.length ? "" : `The clipboard is empty, or the browser would not share it. Press ${this.pasteKey} here to paste.`);
    }, () => {
      if (!this.element.hidden) this.setStatus(`The browser would not share the clipboard. Press ${this.pasteKey} here to paste.`);
    });
  }

  close() {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this.entries = [];
    this.items.replaceChildren();
    this.onClose();
  }

  add(entries) {
    if (!entries?.length) return;
    this.entries.push(...entries);
    const names = uniqueSaveNames(this.entries.map(item => item.name));
    this.entries.forEach((item, index) => { item.name = names[index]; });
    this.renderItems();
    this.setStatus("");
  }

  renderItems() {
    this.items.replaceChildren();
    if (!this.entries.length) {
      const empty = document.createElement("p");
      empty.className = "save-clipboard-empty";
      empty.textContent = "Nothing to save yet.";
      this.items.append(empty);
    }
    for (const item of this.entries) {
      const row = document.createElement("div");
      row.className = "save-clipboard-item";
      const include = document.createElement("input");
      include.type = "checkbox";
      include.checked = item.include;
      include.setAttribute("aria-label", `Save ${item.name}`);
      include.addEventListener("change", () => { item.include = include.checked; this.updateSaveButton(); });
      const name = document.createElement("input");
      name.type = "text";
      name.className = "rename-window-input";
      name.value = item.name;
      name.spellcheck = false;
      name.setAttribute("aria-label", "File name");
      name.addEventListener("input", () => { item.name = name.value.trim(); this.updateSaveButton(); });
      name.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void this.save();
        }
      });
      const detail = document.createElement("span");
      detail.className = "save-clipboard-detail";
      detail.textContent = `${item.kind} · ${describeSize(item.blob.size)}`;
      row.append(include, name, detail);
      this.items.append(row);
    }
    this.updateSaveButton();
  }

  updateSaveButton() {
    const chosen = this.entries.filter(item => item.include);
    this.saveButton.disabled = this.saving || !chosen.length || chosen.some(item => !item.name) || !this.directory.value.trim();
  }

  renderPresets() {
    this.presets.replaceChildren();
    const byName = new Map(this.locations.map(location => [location.name, location.path]));
    const presets = [["Home", byName.get("Home")], ["Temp", byName.get("Temp")], ["Current", this.current]];
    for (const location of this.locations) {
      if (!["Home", "Temp"].includes(location.name)) presets.push([location.name, location.path]);
    }
    for (const [label, path] of presets) {
      const node = this.button(label, () => void this.browse(path));
      node.disabled = !path;
      node.title = path || (label === "Current" ? "The active window has not reported its folder" : "Not available on this host");
      this.presets.append(node);
    }
  }

  // Lists path's folders and makes it the destination. With fallback, a
  // missing or unlistable path opens Home instead.
  async browse(path, { fallback = false } = {}) {
    const listing = ++this.listing;
    let data;
    try {
      data = await this.list(path);
    } catch (error) {
      if (fallback && path) return this.browse("", { fallback });
      if (listing === this.listing) this.setStatus(error.message, { error: true });
      return;
    }
    if (listing !== this.listing || this.element.hidden) return;
    const home = (data.locations || []).find(location => location.name === "Home")?.path;
    if (fallback && !path && home && home !== data.path) return this.browse(home);
    this.locations = data.locations || [];
    this.directory.value = data.path || "";
    this.renderPresets();
    this.folders.replaceChildren();
    if (data.parent) this.folders.append(this.folderButton("..", data.parent, "Up one folder"));
    for (const folder of data.entries || []) this.folders.append(this.folderButton(folder.name, folder.path, folder.path));
    this.updateSaveButton();
  }

  folderButton(label, path, title) {
    const node = this.button(label, () => void this.browse(path));
    node.className = "directory-browser-entry";
    node.title = title;
    return node;
  }

  async list(path) {
    const response = await this.fetchImpl(path ? `/api/directories?path=${encodeURIComponent(path)}` : "/api/directories", { credentials: "same-origin" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not open ${path || "the folder"}`);
    return data;
  }

  async save() {
    const chosen = this.entries.filter(item => item.include);
    const directory = this.directory.value.trim();
    if (this.saving || !chosen.length || !directory) return;
    this.saving = true;
    this.updateSaveButton();
    try {
      const result = await saveEntries(chosen, directory, {
        fetchImpl: this.fetchImpl,
        confirmReplace: this.confirmReplace,
        onProgress: text => this.setStatus(text),
      });
      this.saving = false;
      if (!result.saved.length) {
        this.setStatus("Nothing was saved.");
        this.updateSaveButton();
        return;
      }
      this.onSaved({ ...result, directory });
      this.close();
    } catch (error) {
      this.saving = false;
      this.setStatus(error.message, { error: true });
      this.updateSaveButton();
    }
  }

  setStatus(text, { error = false } = {}) {
    this.status.textContent = text;
    this.status.classList.toggle("is-error", error);
  }
}
