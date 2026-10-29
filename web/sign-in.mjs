import { offerLoginToBrowser } from "./password-manager.mjs";

// Sign-in support for the workspace page. When a sign-in ends (signed out
// elsewhere, expired, revoked, or its password changed) the server answers
// 401, or closes live sockets with 4401. The page then shows a sign-in dialog
// over the workspace and, once signed in again, retries what was waiting, so
// unsaved work and open panes stay where they are.

export const signInEndedCloseCode = 4401;

export function signInURL(location) {
  return `/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
}

function requestURL(input, location) {
  try {
    return new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
  } catch {
    return null;
  }
}

// A request can be sent again unless its body is a one-shot stream. Request
// objects are cloned before the first attempt.
function replayable(init) {
  const body = init?.body;
  return !(body && typeof body.getReader === "function");
}

export class SignInRecovery {
  constructor({ target = globalThis, doc = globalThis.document, config = () => ({ mode: "off", account: "" }) } = {}) {
    this.target = target;
    this.doc = doc;
    this.config = config;
    this.pending = null;
    this.originalFetch = null;
    this.leaving = false;
    this.held = null;
  }

  // install wraps fetch: an API call refused for want of a sign-in waits for
  // the dialog, then is sent once more.
  install() {
    if (this.originalFetch) return;
    const original = this.originalFetch = this.target.fetch.bind(this.target);
    this.target.fetch = async (input, init) => {
      const url = requestURL(input, this.target.location);
      const guarded = url && url.origin === this.target.location.origin && url.pathname.startsWith("/api/")
        && url.pathname !== "/api/auth/login";
      const retry = guarded && typeof input?.clone === "function" ? input.clone() : input;
      const response = await original(input, init);
      if (!guarded || response.status !== 401) return response;
      if (this.config().mode === "off") {
        this.signInTurnedOn();
        return response;
      }
      await this.ensureSignedIn();
      return replayable(init) ? original(retry, init) : response;
    };
  }

  // hold makes ended sign-ins wait while this page changes sign-in itself
  // (Settings → Sign-in); after a change succeeds the page starts afresh,
  // so they need no dialog. promise resolves to { ok }.
  hold(promise) {
    this.held = promise;
    const release = () => {
      if (this.held === promise) this.held = null;
    };
    promise.then(release, release);
  }

  // signInTurnedOn handles a sign-in demand on a page that loaded while
  // sign-in was off: Settings elsewhere turned it on, so the page goes to
  // the login page and comes back.
  signInTurnedOn() {
    if (this.leaving) return;
    this.leaving = true;
    Promise.resolve(this.held).then(result => {
      if (!result?.ok) this.target.location.assign(signInURL(this.target.location));
    });
  }

  // ensureSignedIn shows one dialog however many requests are waiting, and
  // resolves when the user has signed in again.
  ensureSignedIn() {
    if (this.held) {
      return this.held.then(result => (result?.ok ? new Promise(() => {}) : this.ensureSignedIn()));
    }
    if (this.config().mode === "off") {
      this.signInTurnedOn();
      return new Promise(() => {});
    }
    this.pending ??= new Promise(resolve => this.showDialog(() => {
      this.pending = null;
      resolve();
    }));
    return this.pending;
  }

  showDialog(done) {
    const doc = this.doc;
    const { mode, account } = this.config();
    const modal = doc.createElement("div");
    modal.className = "settings-modal sign-in-modal";
    const panel = doc.createElement("section");
    panel.className = "settings-panel sign-in-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "sign-in-title");
    const titleBar = doc.createElement("div");
    titleBar.className = "settings-title";
    const title = doc.createElement("h2");
    title.id = "sign-in-title";
    title.textContent = "Sign In Again";
    titleBar.appendChild(title);

    const form = doc.createElement("form");
    form.className = "settings-content sign-in-content";
    const intro = doc.createElement("p");
    intro.textContent = mode === "system" || account
      ? `Your sign-in ended. Sign in as ${account || "this account"} to continue where you left off.`
      : "Your sign-in ended. Sign in to continue where you left off.";
    const error = doc.createElement("p");
    error.className = "sign-in-error";
    error.setAttribute("role", "alert");

    const name = doc.createElement("input");
    name.name = "username";
    name.autocomplete = "username";
    name.value = account || "";
    if (mode === "system") {
      name.type = "hidden";
    } else {
      name.type = "text";
      name.autocapitalize = "off";
      name.spellcheck = false;
      name.required = true;
    }
    const password = doc.createElement("input");
    password.type = "password";
    password.name = "password";
    password.autocomplete = "current-password";
    password.required = true;
    for (const input of [name, password]) input.className = "rename-window-input";
    const remember = doc.createElement("input");
    remember.type = "checkbox";
    remember.name = "remember";

    const field = (text, input) => {
      const label = doc.createElement("label");
      label.className = "sign-in-field";
      const caption = doc.createElement("span");
      caption.textContent = text;
      label.append(caption, input);
      return label;
    };
    const rememberLabel = doc.createElement("label");
    rememberLabel.className = "sign-in-remember";
    rememberLabel.append(remember, doc.createTextNode(" Keep me signed in on this device"));

    const actions = doc.createElement("div");
    actions.className = "rename-window-actions";
    const pageButton = doc.createElement("button");
    pageButton.type = "button";
    pageButton.className = "settings-background-button";
    pageButton.textContent = "Sign-in Page";
    pageButton.addEventListener("click", () => this.target.location.assign(signInURL(this.target.location)));
    const submit = doc.createElement("button");
    submit.type = "submit";
    submit.className = "settings-background-button server-connection-primary";
    submit.textContent = "Sign In";
    actions.append(pageButton, submit);

    form.append(intro, error);
    if (mode === "system") form.append(name);
    else form.append(field("Name", name));
    form.append(field("Password", password), rememberLabel, actions);
    panel.append(titleBar, form);
    modal.appendChild(panel);
    // Keys typed here belong to the dialog, not to a terminal underneath.
    modal.addEventListener("keydown", event => event.stopPropagation());

    let countdown = null;
    const wait = seconds => {
      submit.disabled = true;
      let left = seconds;
      const tick = () => {
        if (left <= 0) {
          this.target.clearInterval?.(countdown);
          submit.disabled = false;
          submit.textContent = "Sign In";
          return;
        }
        submit.textContent = `Wait ${left}s`;
        left -= 1;
      };
      tick();
      countdown = this.target.setInterval?.(tick, 1000);
    };

    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      error.textContent = "";
      let response;
      try {
        response = await this.originalFetch("/api/auth/login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: name.value, password: password.value, remember: remember.checked }),
        });
      } catch {
        error.textContent = "Could not reach Tessera. Check the connection and try again.";
        submit.disabled = false;
        return;
      }
      if (response.ok) {
        // A sign-in without navigating: offer it to the password manager.
        void offerLoginToBrowser({ username: name.value, password: password.value, name: `${name.value} — Tessera` }, this.target);
        password.value = "";
        modal.remove();
        done();
        return;
      }
      const body = await response.json().catch(() => ({}));
      error.textContent = body.error || "Could not sign in.";
      password.value = "";
      if (response.status === 429 && body.retryAfter > 0) wait(body.retryAfter);
      else submit.disabled = false;
      password.focus();
    });

    doc.body.appendChild(modal);
    (mode === "system" || name.value ? password : name).focus();
  }
}

// signOut ends the sign-in, then shows the login page. It uses fetch rather
// than a form: under the page's no-referrer policy a form post would carry
// "Origin: null", which the server refuses.
export async function signOut(target = globalThis) {
  try {
    await target.fetch("/logout", { method: "POST", credentials: "same-origin" });
  } finally {
    target.location.assign("/login");
  }
}

export function describeLastActive(seconds, nowSeconds) {
  const ago = Math.max(0, nowSeconds - seconds);
  if (ago < 120) return "Active now";
  if (ago < 3600) return `${Math.round(ago / 60)} minutes ago`;
  if (ago < 172800) return `${Math.round(ago / 3600)} hours ago`;
  return `${Math.round(ago / 86400)} days ago`;
}

// renderSignedInDevices fills a Settings section with this account's
// sign-ins, each with Sign out, plus Sign Out Everywhere.
export async function renderSignedInDevices(section, { doc = globalThis.document, target = globalThis, now = () => Date.now() } = {}) {
  const status = doc.createElement("p");
  status.className = "settings-row-detail";
  status.textContent = "Loading signed-in devices...";
  section.appendChild(status);
  const refresh = () => {
    for (const child of [...section.children].slice(1)) child.remove();
    return renderSignedInDevices(section, { doc, target, now });
  };
  let body;
  try {
    const response = await target.fetch("/api/auth/sign-ins", { credentials: "same-origin" });
    if (!response.ok) throw new Error(response.statusText);
    body = await response.json();
  } catch {
    status.textContent = "Could not load signed-in devices.";
    return;
  }
  status.remove();
  const end = async (path) => {
    const response = await target.fetch(path, { method: "DELETE", credentials: "same-origin" });
    return response.ok;
  };
  for (const signIn of body.signIns || []) {
    const row = doc.createElement("div");
    row.className = "settings-row signed-in-device";
    const label = doc.createElement("span");
    label.className = "settings-row-label";
    const name = doc.createElement("strong");
    name.textContent = signIn.current ? `${signIn.device} (this device)` : signIn.device;
    const detail = doc.createElement("span");
    const kept = signIn.remember ? "Kept signed in" : "Until the browser session ends";
    detail.textContent = `${describeLastActive(signIn.lastSeenAt, Math.floor(now() / 1000))} · ${signIn.lastIp || signIn.createdIp} · ${kept}`;
    label.append(name, detail);
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "settings-background-button";
    button.textContent = "Sign Out";
    button.addEventListener("click", async () => {
      button.disabled = true;
      if (await end(`/api/auth/sign-ins/${encodeURIComponent(signIn.id)}`)) {
        if (signIn.current) target.location.assign("/login");
        else void refresh();
      } else {
        button.disabled = false;
      }
    });
    row.append(label, button);
    section.appendChild(row);
  }
  const everywhere = doc.createElement("div");
  everywhere.className = "settings-row";
  const label = doc.createElement("span");
  label.className = "settings-row-label";
  const name = doc.createElement("strong");
  name.textContent = "Every device";
  const detail = doc.createElement("span");
  detail.textContent = "Ends every sign-in for this account, including this one. Open terminals keep running.";
  label.append(name, detail);
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "settings-background-button";
  button.textContent = "Sign Out Everywhere";
  button.addEventListener("click", async () => {
    button.disabled = true;
    if (await end("/api/auth/sign-ins")) target.location.assign("/login");
    else button.disabled = false;
  });
  everywhere.append(label, button);
  section.appendChild(everywhere);
}
