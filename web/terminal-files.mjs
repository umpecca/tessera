import { newWorkspaceRevision } from "./workspace-concurrency.mjs";

// File contents never enter the terminal transport or a browser Blob buffer.
export class TerminalFiles {
  constructor({ workspaceId, paneId, container, send, onPending = () => {}, fetchImpl = globalThis.fetch }) {
    Object.assign(this, { workspaceId, paneId, container, send, onPending, fetch: fetchImpl });
    this.fetch = fetchImpl.bind(globalThis);
    this.clientId = newWorkspaceRevision();
    this.requests = new Map();
    this.epoch = "";
    this.disposed = false;
    this.downloadFrames = new Set();
    this.downloadTimers = new Map();
    this.downloadForms = new Map();
    this.panel = document.createElement("div");
    this.panel.className = "terminal-file-panel";
    this.panel.hidden = true;
    container.append(this.panel);
  }

  subscribe(socket) {
    socket.send(JSON.stringify({ type: "file-events", enabled: true, clientId: this.clientId }));
  }

  receive(message) {
    if (message?.type === "file-events") {
      if (this.epoch && this.epoch !== message.epoch) this.disconnect();
      this.epoch = message.epoch;
      return true;
    }
    if (message?.type !== "terminal-file") return false;
    if (this.disposed || (this.epoch && message.epoch !== this.epoch)) return true;
    this.epoch = message.epoch;
    const item = this.requests.get(message.id);
    if (message.action === "reset") this.disconnect();
    else if (message.action === "request" && !item && this.requests.size < 4) this.offer(message);
    else if (message.action === "claimed" && item && !item.claiming && !item.ticket) this.remove(item);
    else if (message.action === "progress" && item) item.text.textContent = `Transferred ${message.bytes} bytes`;
    else if (message.action === "finished" && item) {
      item.finished = true;
      if (message.error) this.error(item, message.error);
      else this.remove(item);
    }
    return true;
  }

  offer(message) {
    const card = document.createElement("div");
    card.className = "terminal-file-card";
    card.setAttribute("role", "status");
    card.addEventListener("pointerdown", event => event.stopPropagation());
    const text = document.createElement("span");
    text.textContent = message.operation === "upload"
      ? `Upload files to ${message.directory}`
      : `Download ${message.files.map(file => file.name).join(", ")} (${message.bytes} bytes)`;
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = message.operation === "upload" ? "Choose files" : "Download";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const item = { ...message, card, text, action, cancel, cancelled: false, claiming: false, ticket: "", request: null };
    card.append(text, action, cancel);
    this.requests.set(item.id, item);
    this.panel.append(card);
    this.panel.hidden = false;
    this.onPending(this.requests.size);
    cancel.addEventListener("click", () => { this.cancel(item); });
    action.addEventListener("click", () => {
      if (item.operation === "upload") this.choose(item);
      else void this.download(item).catch(error => this.error(item, error.message));
    });
  }

  choose(item) {
    if (item.claiming || item.cancelled) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    item.card.append(input);
    input.addEventListener("change", () => {
      const files = [...input.files];
      input.remove();
      if (files.length) void this.upload(item, files).catch(error => this.error(item, error.message));
    }, { once: true });
    input.addEventListener("cancel", () => input.remove(), { once: true });
    input.click(); // Must stay synchronous with the browser's user gesture.
  }

  async post(action, body, options = {}) {
    const response = await this.fetch(`/api/terminal-files/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), ...options,
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || `Transfer failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async claim(item, files = []) {
    if (item.cancelled || this.disposed) throw new Error("Transfer cancelled");
    item.claiming = true;
    item.action.disabled = true;
    try {
      const result = await this.post("claim", {
        workspaceId: this.workspaceId, paneId: this.paneId, epoch: item.epoch,
        id: item.id, clientId: this.clientId,
        files: files.map(file => ({ name: file.name, bytes: file.size })),
      });
      item.ticket = result.ticket;
      if (item.cancelled || this.disposed) {
        await this.post("cancel", { ticket: item.ticket });
        throw new Error("Transfer cancelled");
      }
    } catch (error) {
      if (error.status === 410) this.remove(item);
      throw error;
    } finally { item.claiming = false; }
  }

  async upload(item, files) {
    await this.claim(item, files);
    for (let index = 0; index < files.length && !item.cancelled; index++) {
      const file = files[index];
      try {
        try { await this.uploadOne(item, file, index, false); }
        catch (error) {
          if (error.status !== 409) throw error;
          if (!globalThis.confirm(`${file.name} already exists. Replace it?`)) {
            await this.post("result", { ticket: item.ticket, index, status: "skipped" });
            continue;
          }
          await this.uploadOne(item, file, index, true);
        }
      } catch (error) {
        if (item.cancelled) return;
        await this.post("result", { ticket: item.ticket, index, status: "failed", error: error.message });
      }
    }
    if (!item.cancelled) {
      await this.post("finish", { ticket: item.ticket });
      this.remove(item);
    }
  }

  uploadOne(item, file, index, overwrite) {
    return new Promise((resolve, reject) => {
      if (item.cancelled) { reject(new Error("Transfer cancelled")); return; }
      const xhr = new XMLHttpRequest();
      item.request = xhr;
      xhr.open("POST", `/api/terminal-files/upload?index=${index}&overwrite=${overwrite ? "1" : "0"}`);
      xhr.setRequestHeader("X-Tessera-Transfer", item.ticket);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.addEventListener("progress", event => {
        item.text.textContent = `Uploading ${file.name} (${index + 1}): ${event.loaded}/${file.size} bytes`;
      });
      const fail = (message, status = 0) => { const error = new Error(message); error.status = status; reject(error); };
      xhr.addEventListener("load", () => {
        item.request = null;
        let result = {};
        try { result = JSON.parse(xhr.responseText || "{}"); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(result);
        else fail(result.error || "Upload failed", xhr.status);
      });
      xhr.addEventListener("error", () => { item.request = null; fail("Connection lost during upload"); });
      xhr.addEventListener("abort", () => { item.request = null; fail("Upload cancelled"); });
      xhr.send(file);
    });
  }

  async download(item) {
    await this.claim(item);
    item.text.textContent = "Sending download to your browser";
    // A native attachment response streams directly to the browser download
    // manager. Never fetch into a Blob or claim the file was saved to disk.
    const frame = document.createElement("iframe");
    frame.name = `tessera-file-${this.clientId}-${item.id}`;
    frame.hidden = true;
    const ready = new Promise((resolve, reject) => {
      frame.addEventListener("load", resolve, { once: true });
      frame.addEventListener("error", () => reject(new Error("Download target could not open")), { once: true });
    });
    frame.src = "/api/terminal-files/frame";
    document.body.append(frame);
    this.downloadFrames.add(frame);
    item.frame = frame;
    await ready;
    if (item.cancelled || this.disposed || this.requests.get(item.id) !== item) return;
    const targetDocument = frame.contentDocument;
    if (!targetDocument) throw new Error("Download target is unavailable");
    const form = targetDocument.createElement("form");
    form.method = "POST";
    form.action = "/api/terminal-files/download";
    form.target = "_self";
    const ticket = targetDocument.createElement("input");
    ticket.type = "hidden"; ticket.name = "ticket"; ticket.value = item.ticket;
    form.hidden = true;
    form.append(ticket); targetDocument.body.append(form);
    this.downloadForms.set(frame, form);
    form.submit();
  }

  cancel(item) {
    item.cancelled = true;
    item.request?.abort();
    if (item.frame) this.removeDownload(item.frame);
    if (item.frame) this.downloadFrames.delete(item.frame);
    if (item.ticket) void this.post("cancel", { ticket: item.ticket }, { keepalive: true }).catch(() => {});
    else this.send({ type: "file-decline", id: item.id, epoch: item.epoch });
    this.remove(item);
  }

  error(item, message) {
    if (item.cancelled || this.disposed || this.requests.get(item.id) !== item) return;
    item.request?.abort();
    item.text.textContent = message;
    item.card.classList.add("is-error");
    item.action.hidden = Boolean(item.ticket) || Boolean(item.finished);
    item.action.disabled = false;
    item.cancel.textContent = "Dismiss";
  }

  remove(item) {
    item.card.remove();
    if (this.requests.get(item.id) === item) this.requests.delete(item.id);
    this.panel.hidden = this.requests.size === 0;
    // Let the browser finish receiving a successful native download before
    // removing its target browsing context.
    if (item.frame && !item.cancelled) {
      const timer = setTimeout(() => { this.removeDownload(item.frame); this.downloadTimers.delete(item.frame); }, 60000);
      this.downloadTimers.set(item.frame, timer);
      if (this.downloadTimers.size > 4) {
        const [frame, oldTimer] = this.downloadTimers.entries().next().value;
        clearTimeout(oldTimer); this.removeDownload(frame); this.downloadTimers.delete(frame);
      }
    }
    this.onPending(this.requests.size);
  }

  removeDownload(frame) { frame.remove(); this.downloadForms.get(frame)?.remove(); this.downloadForms.delete(frame); this.downloadFrames.delete(frame); }

  disconnect() { for (const item of [...this.requests.values()]) this.cancel(item); }
  dispose() {
    this.disconnect(); this.disposed = true;
    for (const frame of this.downloadFrames) this.removeDownload(frame);
    this.downloadFrames.clear();
    for (const timer of this.downloadTimers.values()) clearTimeout(timer);
    this.downloadTimers.clear();
    this.panel.remove();
  }
}
