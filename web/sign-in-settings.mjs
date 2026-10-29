// Settings → Sign-in: whether Tessera asks for a password, and, with Tessera
// accounts, the accounts themselves. Admins change these; while sign-in is
// off anyone who can reach Tessera may turn it on. Forms open in their own
// dialog over Settings, which re-renders as other settings change.

export const signInModeNames = { off: "Off", file: "Tessera accounts", system: "Host account" };

export function describeSignInMode(settings) {
  switch (settings.mode) {
    case "file":
      return "Each person signs in with a Tessera account and has their own workspaces.";
    case "system":
      return `Sign in with the password of ${settings.systemAccount || "the host account"}, the account Tessera runs as.`;
  }
  return settings.exposed
    ? "Anyone who can reach Tessera from another device can use it, including its terminals."
    : "Anyone using this computer can open Tessera without signing in.";
}

// modeChoices lists the modes the change dialog offers.
export function modeChoices(settings) {
  return ["off", "file", "system"].filter(mode => mode === settings.mode || mode === "off"
    || (mode === "file" && settings.fileAvailable) || (mode === "system" && settings.systemAvailable));
}

// offersWorkspaceMove reports whether a change gives the person at the
// keyboard different workspaces: Tessera accounts keep workspaces per
// account, the other modes share one set.
export function offersWorkspaceMove(settings, mode) {
  return Boolean(settings.canMoveWorkspaces) && (settings.mode === "file") !== (mode === "file");
}

async function requestJSON(target, path, method, body) {
  let response;
  try {
    response = await target.fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "Could not reach Tessera. Check the connection and try again." };
  }
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (response.ok) return { ok: true, payload };
  return { ok: false, status: response.status, error: payload.error || "Something went wrong.", retryAfter: payload.retryAfter };
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(doc, text, onClick, { primary = false, danger = false } = {}) {
  const node = element(doc, "button", "settings-background-button", text);
  node.type = "button";
  if (primary) node.classList.add("server-connection-primary");
  if (danger) node.classList.add("is-danger");
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

function field(doc, text, input) {
  const label = element(doc, "label", "sign-in-field");
  label.append(element(doc, "span", "", text), input);
  return label;
}

function input(doc, type, name, autocomplete) {
  const node = element(doc, "input", "rename-window-input");
  node.type = type;
  node.name = name;
  node.autocomplete = autocomplete;
  if (type === "text") {
    node.autocapitalize = "off";
    node.spellcheck = false;
  }
  return node;
}

function checkbox(doc, text, checked = false) {
  const box = doc.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  const label = element(doc, "label", "sign-in-remember");
  label.append(box, doc.createTextNode(` ${text}`));
  return { box, label };
}

// openDialog shows a form over Settings. submit returns null on success or
// a failure from requestJSON; the dialog stays open to show its error.
function openDialog(doc, target, { title, submitLabel, danger = false, build, submit, done }) {
  const modal = element(doc, "div", "settings-modal sign-in-modal");
  const panel = element(doc, "section", "settings-panel sign-in-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  const titleBar = element(doc, "div", "settings-title");
  const heading = element(doc, "h2", "", title);
  heading.id = "sign-in-settings-title";
  panel.setAttribute("aria-labelledby", heading.id);
  titleBar.appendChild(heading);
  const form = element(doc, "form", "settings-content sign-in-content");
  const error = element(doc, "p", "sign-in-error");
  error.setAttribute("role", "alert");
  const actions = element(doc, "div", "rename-window-actions");
  const close = () => modal.remove();
  const confirm = element(doc, "button", "settings-background-button server-connection-primary", submitLabel);
  confirm.type = "submit";
  if (danger) confirm.classList.add("is-danger");
  actions.append(button(doc, "Cancel", close), confirm);
  const focus = build(form, error);
  form.append(error, actions);
  panel.append(titleBar, form);
  modal.appendChild(panel);
  modal.addEventListener("pointerdown", event => {
    if (event.target === modal) close();
  });
  // Keys typed here belong to the dialog, not to Settings or a terminal.
  modal.addEventListener("keydown", event => {
    if (event.key === "Escape") close();
    event.stopPropagation();
  });
  let countdown = null;
  const wait = seconds => {
    let left = seconds;
    const tick = () => {
      if (left <= 0) {
        target.clearInterval?.(countdown);
        confirm.disabled = false;
        confirm.textContent = submitLabel;
        return;
      }
      confirm.textContent = `Wait ${left}s`;
      left -= 1;
    };
    tick();
    countdown = target.setInterval?.(tick, 1000);
  };
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (confirm.disabled) return;
    confirm.disabled = true;
    error.textContent = "";
    const failure = await submit();
    if (!failure) {
      close();
      done?.();
      return;
    }
    error.textContent = failure.error;
    if (failure.status === 429 && failure.retryAfter > 0) wait(failure.retryAfter);
    else confirm.disabled = false;
  });
  doc.body.appendChild(modal);
  (focus || confirm).focus();
}

function newPasswordFields(doc, form, label = "Password") {
  const password = input(doc, "password", "new-password", "new-password");
  const repeat = input(doc, "password", "repeat-password", "new-password");
  password.required = repeat.required = true;
  form.append(field(doc, label, password), field(doc, "Repeat password", repeat));
  return {
    value: () => password.value,
    mismatch: () => (password.value !== repeat.value ? { error: "The passwords don't match." } : null),
  };
}

// openChangeSignInDialog changes the mode. recovery is the page's
// SignInRecovery, which must not ask to sign in again while this page's own
// change closes its connections.
export function openChangeSignInDialog(settings, { doc = globalThis.document, target = globalThis, recovery = null } = {}) {
  const choices = modeChoices(settings);
  let mode = choices.find(choice => choice !== settings.mode) || settings.mode;
  let read = () => ({});
  openDialog(doc, target, {
    title: "Sign-in",
    submitLabel: "Apply",
    build(form) {
      const select = element(doc, "select", "settings-theme-select");
      select.setAttribute("aria-label", "Require sign-in");
      for (const choice of choices) {
        const option = element(doc, "option", "", signInModeNames[choice] + (choice === settings.mode ? " (now)" : ""));
        option.value = choice;
        option.selected = choice === mode;
        select.appendChild(option);
      }
      const details = element(doc, "div", "sign-in-content");
      const render = () => {
        details.replaceChildren();
        const parts = [];
        let move = null;
        let remember = null;
        if (offersWorkspaceMove(settings, mode)) {
          move = checkbox(doc, "Bring my workspaces, settings and shortcuts along", true);
        }
        if (mode === "off") {
          const current = input(doc, "password", "password", "current-password");
          current.required = true;
          const who = settings.mode === "system" ? settings.systemAccount : settings.account;
          parts.push(element(doc, "p", "", settings.exposed
            ? "Anyone who can reach this Tessera from another device will be able to use it, including its terminals, without a password."
            : "Anyone using this computer will be able to open Tessera without a password."));
          parts.push(field(doc, `Password for ${who}`, current));
          read = () => ({ currentPassword: current.value });
        } else if (mode === "file") {
          const name = input(doc, "text", "username", "username");
          name.required = true;
          if (settings.mode === "system") name.value = settings.account || "";
          parts.push(element(doc, "p", "", "You'll be signed in with this admin account. To use an existing account, enter its password; otherwise it is created."));
          parts.push(field(doc, "Admin account", name));
          const fields = element(doc, "div", "sign-in-content");
          const password = newPasswordFields(doc, fields);
          parts.push(...fields.children);
          remember = checkbox(doc, "Keep me signed in on this device");
          read = () => password.mismatch() || ({ account: name.value.trim(), password: password.value() });
        } else if (mode === "system") {
          const password = input(doc, "password", "password", "current-password");
          password.required = true;
          parts.push(element(doc, "p", "", `Everyone signs in with the password of ${settings.systemAccount}, the account Tessera runs as.`));
          parts.push(field(doc, `Password for ${settings.systemAccount}`, password));
          remember = checkbox(doc, "Keep me signed in on this device");
          read = () => ({ password: password.value });
        }
        if (mode !== "off") {
          parts.push(element(doc, "p", "", settings.mode === "off"
            ? "Other open Tessera pages will be asked to sign in."
            : "Everyone else will be signed out."));
        }
        if (move) parts.push(move.label);
        if (remember) parts.push(remember.label);
        details.append(...parts);
        const base = read;
        read = () => {
          const values = base();
          if (values.error) return values;
          return { ...values, remember: Boolean(remember?.box.checked), moveWorkspaces: Boolean(move?.box.checked) };
        };
      };
      select.addEventListener("change", () => {
        mode = select.value;
        render();
      });
      render();
      form.append(field(doc, "Require sign-in", select), details);
      return select;
    },
    async submit() {
      if (mode === settings.mode) return { error: "Choose a different setting." };
      const values = read();
      if (values.error) return values;
      const request = requestJSON(target, "/api/auth/settings", "PUT", { mode, ...values });
      recovery?.hold(request);
      const result = await request;
      return result.ok ? null : result;
    },
    // Whose workspaces this page shows may have changed; start afresh.
    done: () => target.location.assign("/"),
  });
}

function openAddAccountDialog(options, refresh) {
  const { doc, target } = options;
  let read = () => ({});
  openDialog(doc, target, {
    title: "Add Account",
    submitLabel: "Add",
    build(form) {
      const name = input(doc, "text", "new-account", "off");
      name.required = true;
      form.append(field(doc, "Name", name));
      const password = newPasswordFields(doc, form);
      const admin = checkbox(doc, "Admin: can manage accounts and sign-in");
      form.append(admin.label);
      read = () => password.mismatch() || ({ name: name.value.trim(), password: password.value(), admin: admin.box.checked });
      return name;
    },
    async submit() {
      const values = read();
      if (values.error) return values;
      const result = await requestJSON(target, "/api/auth/accounts", "POST", values);
      return result.ok ? null : result;
    },
    done: refresh,
  });
}

function openPasswordDialog(account, options, refresh) {
  const { doc, target } = options;
  let read = () => ({});
  openDialog(doc, target, {
    title: `Password for ${account.name}`,
    submitLabel: "Set Password",
    build(form) {
      form.append(element(doc, "p", "", account.current
        ? "Your other devices will be signed out."
        : `${account.name} will be signed out everywhere.`));
      const password = newPasswordFields(doc, form, "New password");
      read = () => password.mismatch() || ({ password: password.value() });
      return form.querySelector?.("input") ?? null;
    },
    async submit() {
      const values = read();
      if (values.error) return values;
      const result = await requestJSON(target, `/api/auth/accounts/${encodeURIComponent(account.name)}`, "PATCH", values);
      return result.ok ? null : result;
    },
    done: refresh,
  });
}

function openRemoveDialog(account, options, refresh) {
  const { doc, target } = options;
  openDialog(doc, target, {
    title: "Remove Account",
    submitLabel: "Remove",
    danger: true,
    build(form) {
      form.append(element(doc, "p", "", `Remove ${account.name}? Their sign-ins end at once. Their workspaces are kept, and come back if an account with this name is added again.`));
      return null;
    },
    async submit() {
      const result = await requestJSON(target, `/api/auth/accounts/${encodeURIComponent(account.name)}`, "DELETE");
      return result.ok ? null : result;
    },
    done: refresh,
  });
}

function settingsRow(doc, nameText, detailText, controls = []) {
  const row = element(doc, "div", "settings-row");
  const label = element(doc, "span", "settings-row-label");
  label.append(element(doc, "strong", "", nameText), element(doc, "span", "", detailText));
  const actions = element(doc, "span", "sign-in-account-actions");
  actions.append(...controls);
  row.append(label, actions);
  return row;
}

async function renderAccounts(section, options, refresh) {
  const { doc, target } = options;
  const status = element(doc, "p", "settings-row-detail", "Loading accounts...");
  section.appendChild(status);
  const listed = await requestJSON(target, "/api/auth/accounts", "GET");
  if (!listed.ok) {
    status.textContent = `Could not load accounts: ${listed.error}`;
    return;
  }
  status.textContent = "";
  status.setAttribute("role", "status");
  const admins = listed.payload.accounts.filter(account => account.admin).length;
  for (const account of listed.payload.accounts) {
    const roles = [account.admin ? "Admin" : "Can use Tessera", account.current ? "you" : ""].filter(Boolean).join(" · ");
    const adminButton = button(doc, account.admin ? "Remove Admin" : "Make Admin", async () => {
      adminButton.disabled = true;
      const result = await requestJSON(target, `/api/auth/accounts/${encodeURIComponent(account.name)}`, "PATCH", { admin: !account.admin });
      if (result.ok) {
        void refresh();
      } else {
        status.textContent = result.error;
        adminButton.disabled = false;
      }
    });
    // The last admin stays one, so someone can always manage accounts.
    adminButton.disabled = account.admin && admins <= 1;
    const remove = button(doc, "Remove", () => openRemoveDialog(account, options, refresh), { danger: true });
    remove.disabled = account.current;
    section.appendChild(settingsRow(doc, account.name, roles, [
      button(doc, "Password...", () => openPasswordDialog(account, options, refresh)),
      adminButton,
      remove,
    ]));
  }
  section.appendChild(settingsRow(doc, "New account", "Accounts are kept in the credentials file on the host.",
    [button(doc, "Add Account...", () => openAddAccountDialog(options, refresh))]));
}

// renderSignInSettings fills Settings → Sign-in.
export async function renderSignInSettings(section, { doc = globalThis.document, target = globalThis, recovery = null } = {}) {
  const options = { doc, target, recovery };
  const refresh = () => {
    for (const child of [...section.children].slice(1)) child.remove();
    return renderSignInSettings(section, options);
  };
  const status = element(doc, "p", "settings-row-detail", "Loading sign-in settings...");
  section.appendChild(status);
  const loaded = await requestJSON(target, "/api/auth/settings", "GET");
  if (!loaded.ok) {
    status.textContent = "Could not load sign-in settings.";
    return;
  }
  status.remove();
  const settings = loaded.payload;
  let detail = describeSignInMode(settings);
  if (settings.locked) detail += " Set with -auth when Tessera starts.";
  const controls = settings.canManage && !settings.locked
    ? [button(doc, "Change...", () => openChangeSignInDialog(settings, options))]
    : [];
  section.appendChild(settingsRow(doc, `Require sign-in: ${signInModeNames[settings.mode] || settings.mode}`, detail, controls));
  if (settings.mode !== "file") return;
  if (settings.noAdmins) {
    section.appendChild(element(doc, "p", "settings-row-detail",
      "No account is an admin, so accounts can't be managed here. On the host, run: tessera user admin <name>"));
  }
  if (settings.canManage) await renderAccounts(section, options, refresh);
}
