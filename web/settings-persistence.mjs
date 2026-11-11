import { newWorkspaceRevision } from "./workspace-concurrency.mjs";

// Settings have their own revision and save queue, independent of workspaces.
export class SettingsPersistence {
  constructor({ getDocument, onError = error => console.warn(error),
    fetch = (...args) => globalThis.fetch(...args), timers = globalThis, newRevision = newWorkspaceRevision }) {
    Object.assign(this, { getDocument, onError, fetch, timers, newRevision });
    this.generation = 0;
    this.reset(null, "");
  }

  reset(user, revision) {
    this.timers.clearTimeout(this.timer);
    this.generation++;
    this.user = user;
    this.revision = revision;
    this.dirty = false;
    this.timer = null;
    this.savePromise = null;
    this.inFlightRevision = "";
  }

  get url() {
    return `/api/users/${encodeURIComponent(this.user)}/settings`;
  }

  schedule() {
    if (!this.user) return;
    this.dirty = true;
    this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => void this.save().catch(this.onError), 250);
  }

  async save() {
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (this.savePromise) return this.savePromise;
    if (!this.user || !this.dirty) return;
    const generation = this.generation;
    const url = this.url;
    const pending = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const body = { ...this.getDocument(), revision: this.revision, nextRevision: this.newRevision() };
        this.inFlightRevision = body.nextRevision;
        try {
          const response = await this.fetch(url, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body), keepalive: true,
          });
          if (generation !== this.generation) return;
          if (!response.ok) throw new Error(response.status === 409
            ? "Settings changed in another browser. Refresh before saving settings again."
            : `save user settings failed: ${response.status}`);
          const saved = await response.json();
          if (generation !== this.generation) return;
          this.revision = saved.revision;
        } catch (error) {
          if (generation !== this.generation) return;
          this.dirty = true;
          throw error;
        } finally {
          if (generation === this.generation) this.inFlightRevision = "";
        }
      }
    })();
    this.savePromise = pending;
    try {
      await pending;
    } finally {
      if (this.savePromise === pending) this.savePromise = null;
    }
  }

  saveOnExit() {
    if (!this.user || (!this.dirty && !this.savePromise)) return;
    const body = {
      ...this.getDocument(), revision: this.revision,
      nextRevision: this.newRevision(), alternateRevision: this.inFlightRevision,
    };
    void this.fetch(this.url, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), keepalive: true,
    }).catch(() => {});
  }
}
