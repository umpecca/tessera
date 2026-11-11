import { newWorkspaceRevision, workspaceRevisionMatches, workspaceSaveOutcome } from "./workspace-concurrency.mjs";

// Owns the save/reconnect lifecycle. The application supplies a fresh document
// and UI callbacks; this controller knows nothing about panes or modal DOM.
export class WorkspacePersistence {
  constructor({ getDocument, isLoading = () => false, setStatus = () => {}, onConflict = () => {},
    fetch = (...args) => globalThis.fetch(...args), timers = globalThis,
    newRevision = newWorkspaceRevision, reportError = error => console.warn(error) }) {
    Object.assign(this, { getDocument, isLoading, setStatus, onConflict, fetch, timers, newRevision, reportError });
    this.generation = 0;
    this.reset("default", "");
  }

  reset(id, revision) {
    this.timers.clearTimeout(this.timer);
    this.generation++;
    this.id = id;
    this.revision = revision;
    this.suspended = false;
    this.needsRevalidation = false;
    this.queued = false;
    this.timer = null;
    this.savePromise = null;
    this.inFlightRevision = "";
    this.forgetPaneContent();
  }

  forgetPaneContent() {
    this.savedPaneContent = new Map();
  }

  get pending() {
    return this.timer !== null || this.savePromise !== null;
  }

  schedule() {
    if (this.isLoading() || this.suspended) return;
    if (this.needsRevalidation) {
      this.queued = true;
      this.setStatus("saving", "Waiting to reconnect...");
      return;
    }
    this.setStatus("saving", "Saving...");
    this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => void this.save(), 250);
  }

  async flush() {
    if (this.isLoading() || this.suspended || this.needsRevalidation) {
      throw new Error("Workspace saving is paused. Resolve the connection or conflict before leaving this session.");
    }
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (!await this.save()) {
      throw new Error("Workspace could not be saved. Your current session has been kept open.");
    }
  }

  async save() {
    if (this.isLoading() || this.suspended) return false;
    if (this.needsRevalidation) {
      this.queued = true;
      return false;
    }
    if (this.savePromise) {
      this.queued = true;
      return this.savePromise;
    }
    const generation = this.generation;
    // Every waiter shares the entire drain, including edits queued during IO.
    const pending = (async () => {
      do {
        this.queued = false;
        if (!await this.performSave()) return false;
        if (generation !== this.generation || this.suspended || this.needsRevalidation) return false;
      } while (this.queued || this.timer !== null);
      return true;
    })();
    this.savePromise = pending;
    try {
      return await pending;
    } finally {
      if (this.savePromise === pending) this.savePromise = null;
    }
  }

  async performSave() {
    const generation = this.generation;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.setStatus("saving", "Saving...");
    const { body, contentByPaneID } = this.getDocument(this.revision, this.savedPaneContent);
    body.nextRevision = this.newRevision();
    this.inFlightRevision = body.nextRevision;
    try {
      const response = await this.fetch(`/api/workspace/${encodeURIComponent(this.id)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (generation !== this.generation) return false;
      const outcome = workspaceSaveOutcome(this.revision, response.status, data.revision);
      if (outcome.suspended) {
        this.conflict();
        return false;
      }
      if (!response.ok) throw new Error(`save workspace failed: ${response.status}`);
      this.revision = outcome.revision;
      this.savedPaneContent = contentByPaneID;
      if (this.timer === null) this.setStatus("saved", "Saved");
      return true;
    } catch (error) {
      if (generation === this.generation && this.timer === null) {
        this.reportError(error);
        this.setStatus("error", "Save failed", error.message || "Workspace save failed");
      }
      return false;
    } finally {
      if (generation === this.generation) this.inFlightRevision = "";
    }
  }

  saveOnExit() {
    if (this.isLoading() || this.suspended || this.needsRevalidation || !this.pending) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    const { body: payload, contentByPaneID } = this.getDocument(this.revision, this.savedPaneContent);
    // A pending save may carry content reverted locally since the last ACK.
    // Send all final content so this request can safely supersede that save.
    if (this.inFlightRevision) {
      for (const pane of payload.panes) {
        Object.assign(pane, contentByPaneID.get(pane.id));
        delete pane.bufferTextUnchanged;
        delete pane.editorTabsUnchanged;
      }
    }
    payload.nextRevision = this.newRevision();
    payload.alternateRevision = this.inFlightRevision;
    const body = JSON.stringify(payload);
    void this.fetch(`/api/workspace/${encodeURIComponent(this.id)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body,
      // The browser's shared keepalive budget is 64 KiB. Oversized documents
      // must still be attempted as ordinary requests, never silently trimmed.
      keepalive: new TextEncoder().encode(body).byteLength <= 60 * 1024,
    }).catch(() => {});
  }

  conflict() {
    this.suspended = true;
    this.needsRevalidation = false;
    this.queued = false;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.onConflict();
  }

  markDisconnected() {
    if (this.suspended || this.isLoading()) return;
    this.needsRevalidation = true;
    if (this.timer !== null) {
      this.queued = true;
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async revalidate() {
    if (this.suspended || !this.needsRevalidation) return !this.suspended;
    const generation = this.generation;
    try {
      const response = await this.fetch(`/api/workspace/${encodeURIComponent(this.id)}`, { cache: "no-store" });
      if (!response.ok) return false;
      const workspace = await response.json();
      if (generation !== this.generation) return false;
      if (!workspaceRevisionMatches(this.revision, workspace.revision || "")) {
        this.conflict();
        return false;
      }
      this.needsRevalidation = false;
      if (this.queued) {
        this.queued = false;
        this.schedule();
      }
      return true;
    } catch {
      return false;
    }
  }
}
