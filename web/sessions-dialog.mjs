

// Session management, naming and destruction dialogs.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   palette: () => ReturnType<typeof import("./command-palette.mjs").createPalette>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createSessionsDialog(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    sessionSelection: undefined,
    sessionQuery: undefined,
    sessionEntries: undefined,
    sessionsSearchInput: undefined,
    sessionsList: undefined,
    sessionNavigationPending: undefined,
    sessionsModal: undefined,
    sessionActionModal: undefined,
  };

  async function openSessionsModal() {
    dependencies.menus().hideAllMenus();
    try {
      await dependencies.navigation().refreshSessions();
    } catch (error) {
      platform.console.warn(error);
    }
    feature.sessionQuery = "";
    feature.sessionSelection = 0;
    feature.renderSessionsModal();
    const currentIndex = feature.sessionEntries.findIndex((entry) => entry.session.id === dependencies.navigation().currentSessionID);
    if (currentIndex >= 0) {
      feature.sessionSelection = currentIndex;
      feature.renderSessionsResults();
    }
    feature.sessionsModal.hidden = false;
    platform.window.requestAnimationFrame(() => feature.sessionsSearchInput?.focus());
  }

  function hideSessionsModal() {
    feature.sessionsModal.hidden = true;
    feature.sessionsModal.replaceChildren();
    feature.sessionsSearchInput = null;
    feature.sessionsList = null;
    feature.sessionEntries = [];
  }

  function hideSessionActionModal() {
    feature.sessionActionModal.hidden = true;
    feature.sessionActionModal.replaceChildren();
  }

  function renderSessionsModal() {
    feature.sessionsModal.replaceChildren();
    const panel = platform.document.createElement("section");
    panel.className = "settings-panel sessions-panel";
    panel.tabIndex = 0;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "sessions-title");
    panel.addEventListener("keydown", feature.handleSessionsKeyboard);

    const titleBar = platform.document.createElement("div");
    titleBar.className = "settings-title";
    const title = platform.document.createElement("h2");
    title.id = "sessions-title";
    title.textContent = "Sessions";
    const createButton = platform.document.createElement("button");
    createButton.type = "button";
    createButton.className = "settings-background-button";
    createButton.textContent = "Create Session";
    createButton.addEventListener("click", () => feature.openSessionNameDialog("create"));
    const closeButton = platform.document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "settings-close";
    closeButton.textContent = "X";
    closeButton.setAttribute("aria-label", "Close sessions");
    closeButton.addEventListener("click", feature.hideSessionsModal);
    titleBar.append(title, createButton, closeButton);
    panel.appendChild(titleBar);

    const searchInput = platform.document.createElement("input");
    searchInput.className = "command-palette-input sessions-search-input";
    searchInput.type = "text";
    searchInput.placeholder = "Type a session name...";
    searchInput.spellcheck = false;
    searchInput.value = feature.sessionQuery;
    searchInput.setAttribute("aria-label", "Find a session");
    searchInput.addEventListener("input", () => {
      feature.sessionQuery = searchInput.value;
      feature.sessionSelection = 0;
      feature.renderSessionsResults();
    });
    panel.appendChild(searchInput);

    const list = platform.document.createElement("div");
    list.className = "sessions-list command-palette-list";
    panel.appendChild(list);
    feature.sessionsModal.appendChild(panel);
    feature.sessionsSearchInput = searchInput;
    feature.sessionsList = list;
    feature.renderSessionsResults();
  }

  function renderSessionsResults() {
    if (!feature.sessionsList) {
      return;
    }

    const query = feature.sessionQuery.trim();
    feature.sessionEntries = dependencies.navigation().sessions
      .map((session) => ({ session, score: dependencies.palette().paletteScore(query, session.name) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.session.name.localeCompare(b.session.name));
    feature.sessionSelection = Math.min(feature.sessionSelection, Math.max(0, feature.sessionEntries.length - 1));
    feature.sessionsList.replaceChildren();

    if (feature.sessionEntries.length === 0) {
      const empty = platform.document.createElement("div");
      empty.className = "command-palette-empty";
      empty.textContent = "No matching sessions";
      feature.sessionsList.appendChild(empty);
      return;
    }

    feature.sessionEntries.forEach(({ session }, index) => {
      const row = platform.document.createElement("div");
      row.className = "sessions-row";
      row.classList.toggle("is-selected", index === feature.sessionSelection);
      row.classList.toggle("is-current", session.id === dependencies.navigation().currentSessionID);
      const switchButton = platform.document.createElement("button");
      switchButton.type = "button";
      switchButton.className = "sessions-name";
      switchButton.tabIndex = -1;
      switchButton.textContent = session.name;
      switchButton.setAttribute("aria-label", `Switch to session ${session.name}`);
      switchButton.addEventListener("click", () => void dependencies.navigation().switchSession(session));
      const state = platform.document.createElement("span");
      state.className = "sessions-state";
      state.textContent = session.id === dependencies.navigation().currentSessionID ? "Current" : "";
      const renameButton = platform.document.createElement("button");
      renameButton.type = "button";
      renameButton.className = "sessions-action";
      renameButton.textContent = "Rename";
      renameButton.addEventListener("click", () => feature.openSessionNameDialog("rename", session));
      const destroyButton = platform.document.createElement("button");
      destroyButton.type = "button";
      destroyButton.className = "sessions-action is-danger";
      destroyButton.textContent = "Destroy";
      destroyButton.disabled = dependencies.navigation().sessions.length <= 1;
      destroyButton.addEventListener("click", () => feature.openDestroySessionDialog(session));
      row.append(switchButton, state, renameButton, destroyButton);
      feature.sessionsList.appendChild(row);
    });
  }

  function handleSessionsKeyboard(event) {
    if (event.target.closest("button") && event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (feature.sessionEntries.length) {
        feature.sessionSelection = (feature.sessionSelection + (event.key === "ArrowDown" ? 1 : -1) + feature.sessionEntries.length) % feature.sessionEntries.length;
        feature.renderSessionsResults();
        feature.sessionsList?.querySelectorAll(".sessions-row")[feature.sessionSelection]?.scrollIntoView({ block: "nearest" });
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const session = feature.sessionEntries[feature.sessionSelection]?.session;
      if (session) {
        void dependencies.navigation().switchSession(session);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      feature.hideSessionsModal();
    }
  }

  function openSessionNameDialog(mode, session = null) {
    feature.sessionActionModal.replaceChildren();
    const panel = platform.document.createElement("section");
    panel.className = "settings-panel rename-window-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const titleBar = platform.document.createElement("div");
    titleBar.className = "settings-title";
    const title = platform.document.createElement("h2");
    title.textContent = mode === "create" ? "Create Session" : "Rename Session";
    titleBar.appendChild(title);
    const form = platform.document.createElement("form");
    form.className = "settings-content session-action-content";
    const label = platform.document.createElement("label");
    label.textContent = "Session name";
    const input = platform.document.createElement("input");
    input.className = "rename-window-input";
    input.type = "text";
    input.maxLength = 80;
    input.value = session?.name || "";
    const error = platform.document.createElement("div");
    error.className = "session-action-error";
    const actions = platform.document.createElement("div");
    actions.className = "rename-window-actions";
    const cancelButton = platform.document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "settings-background-button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", feature.hideSessionActionModal);
    const submitButton = platform.document.createElement("button");
    submitButton.type = "submit";
    submitButton.className = "settings-background-button";
    submitButton.textContent = mode === "create" ? "Create" : "Rename";
    actions.append(cancelButton, submitButton);
    label.appendChild(input);
    form.append(label, error, actions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submitButton.disabled = true;
      try {
        const endpoint = mode === "create"
          ? dependencies.navigation().userAPIPath("sessions")
          : `${dependencies.navigation().userAPIPath("sessions")}/${encodeURIComponent(session.id)}`;
        const response = await platform.fetch(endpoint, {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: input.value }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || `session ${mode} failed`);
        }
        const saved = await response.json();
        await dependencies.navigation().refreshSessions();
        feature.hideSessionActionModal();
        if (mode === "create") {
          await dependencies.navigation().switchSession(saved);
        } else {
          if (saved.id === dependencies.navigation().currentSessionID) {
            dependencies.navigation().currentSessionName = saved.name;
          }
          feature.renderSessionsModal();
        }
      } catch (requestError) {
        error.textContent = requestError.message;
        submitButton.disabled = false;
        input.focus();
      }
    });
    panel.append(titleBar, form);
    feature.sessionActionModal.appendChild(panel);
    feature.sessionActionModal.hidden = false;
    platform.window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  function openDestroySessionDialog(session) {
    feature.sessionActionModal.replaceChildren();
    const panel = platform.document.createElement("section");
    panel.className = "settings-panel rename-window-panel";
    panel.setAttribute("role", "alertdialog");
    panel.setAttribute("aria-modal", "true");
    const titleBar = platform.document.createElement("div");
    titleBar.className = "settings-title";
    const title = platform.document.createElement("h2");
    title.textContent = "Destroy Session";
    titleBar.appendChild(title);
    const message = platform.document.createElement("p");
    message.textContent = `Destroy “${session.name}”? Its windows, history, background, and running processes will be permanently removed.`;
    const error = platform.document.createElement("div");
    error.className = "session-action-error";
    const actions = platform.document.createElement("div");
    actions.className = "rename-window-actions";
    const cancelButton = platform.document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "settings-background-button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", feature.hideSessionActionModal);
    const destroyButton = platform.document.createElement("button");
    destroyButton.type = "button";
    destroyButton.className = "settings-background-button is-danger";
    destroyButton.textContent = "Destroy";
    destroyButton.addEventListener("click", async () => {
      destroyButton.disabled = true;
      try {
        const response = await platform.fetch(`${dependencies.navigation().userAPIPath("sessions")}/${encodeURIComponent(session.id)}`, { method: "DELETE" });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "destroy session failed");
        }
        const wasCurrent = session.id === dependencies.navigation().currentSessionID;
        await dependencies.navigation().refreshSessions();
        feature.hideSessionActionModal();
        if (wasCurrent) {
          dependencies.navigation().currentSessionID = "";
          dependencies.navigation().currentSessionName = "";
          dependencies.workspace().clearRectanglesForLoad();
          await dependencies.navigation().switchSession(dependencies.navigation().sessions[0], { skipSave: true, historyMode: "replace" });
        } else {
          feature.sessionSelection = Math.min(feature.sessionSelection, Math.max(0, dependencies.navigation().sessions.length - 1));
          feature.renderSessionsModal();
        }
      } catch (requestError) {
        error.textContent = requestError.message;
        destroyButton.disabled = false;
      }
    });
    actions.append(cancelButton, destroyButton);
    panel.append(titleBar, message, error, actions);
    feature.sessionActionModal.appendChild(panel);
    feature.sessionActionModal.hidden = false;
    platform.window.requestAnimationFrame(() => cancelButton.focus());
  }

  function initializeSessionSelection() {
    feature.sessionSelection = 0;
    feature.sessionQuery = "";
    feature.sessionEntries = [];
    feature.sessionsSearchInput = null;
    feature.sessionsList = null;
    feature.sessionNavigationPending = false;
  }

  function initializeSessionsModal() {
    feature.sessionsModal = platform.document.createElement("div");
    feature.sessionsModal.className = "settings-modal sessions-modal";
    feature.sessionsModal.hidden = true;
    feature.sessionsModal.addEventListener("pointerdown", (event) => {
      if (event.target === feature.sessionsModal) {
        feature.hideSessionsModal();
      }
    });
    platform.document.body.appendChild(feature.sessionsModal);
    feature.sessionActionModal = platform.document.createElement("div");
    feature.sessionActionModal.className = "settings-modal session-action-modal";
    feature.sessionActionModal.hidden = true;
    feature.sessionActionModal.addEventListener("pointerdown", (event) => {
      if (event.target === feature.sessionActionModal) {
        feature.hideSessionActionModal();
      }
    });
    platform.document.body.appendChild(feature.sessionActionModal);
  }

  Object.assign(feature, {
    openSessionsModal,
    hideSessionsModal,
    hideSessionActionModal,
    renderSessionsModal,
    renderSessionsResults,
    handleSessionsKeyboard,
    openSessionNameDialog,
    openDestroySessionDialog,
    initializeSessionSelection,
    initializeSessionsModal,
  });
  return feature;
}
