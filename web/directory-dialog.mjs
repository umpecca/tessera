

// Working-directory picker and directory loading states.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createDirectory(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    directoryBrowserRect: undefined,
    directoryBrowserPath: undefined,
    directoryBrowser: undefined,
  };

  async function openDirectoryBrowser(rect, path) {
    if (!rect) {
      return;
    }
    feature.directoryBrowserRect = rect;
    dependencies.menus().hideDockMenu();
    feature.directoryBrowser.hidden = false;
    feature.renderDirectoryBrowserLoading(path || "");

    try {
      await feature.loadDirectoryBrowser(path || "");
    } catch (error) {
      feature.renderDirectoryBrowserError(error.message || "Could not load directory");
    }
  }

  async function loadDirectoryBrowser(path) {
    const url = path ? `/api/directories?path=${encodeURIComponent(path)}` : "/api/directories";
    const response = await platform.fetch(url);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `directory load failed: ${response.status}`);
    }
    feature.directoryBrowserPath = data.path || "";
    feature.renderDirectoryBrowser(data);
  }

  function renderDirectoryBrowserLoading(path) {
    feature.directoryBrowser.replaceChildren();
    const panel = feature.directoryBrowserPanel("Choose Working Directory");
    const pathLine = platform.document.createElement("div");
    pathLine.className = "directory-browser-path";
    pathLine.textContent = path || "host default";
    const message = platform.document.createElement("div");
    message.className = "directory-browser-message";
    message.textContent = "Loading...";
    panel.appendChild(pathLine);
    panel.appendChild(message);
    feature.directoryBrowser.appendChild(panel);
  }

  function renderDirectoryBrowserError(messageText) {
    feature.directoryBrowser.replaceChildren();
    const panel = feature.directoryBrowserPanel("Choose Working Directory");
    const message = platform.document.createElement("div");
    message.className = "directory-browser-message is-error";
    message.textContent = messageText;
    const actions = platform.document.createElement("div");
    actions.className = "directory-browser-actions";
    actions.appendChild(feature.directoryBrowserButton("Close", dependencies.menus().hideDirectoryBrowser));
    panel.appendChild(message);
    panel.appendChild(actions);
    feature.directoryBrowser.appendChild(panel);
  }

  function renderDirectoryBrowser(data) {
    feature.directoryBrowser.replaceChildren();
    const panel = feature.directoryBrowserPanel("Choose Working Directory");

    const pathLine = platform.document.createElement("div");
    pathLine.className = "directory-browser-path";
    pathLine.textContent = data.path || "host default";
    pathLine.title = data.path || "host default";

    const nav = platform.document.createElement("div");
    nav.className = "directory-browser-nav";
    if (data.parent) {
      nav.appendChild(feature.directoryBrowserButton("Up", () => feature.loadDirectoryBrowser(data.parent)));
    }
    for (const root of data.roots || []) {
      nav.appendChild(feature.directoryBrowserButton(root.name, () => feature.loadDirectoryBrowser(root.path)));
    }

    const list = platform.document.createElement("div");
    list.className = "directory-browser-list";
    if ((data.entries || []).length === 0) {
      const empty = platform.document.createElement("div");
      empty.className = "directory-browser-message";
      empty.textContent = "No folders";
      list.appendChild(empty);
    }
    for (const entry of data.entries || []) {
      const button = feature.directoryBrowserButton(entry.name, () => feature.loadDirectoryBrowser(entry.path));
      button.className = "directory-browser-entry";
      button.title = entry.path;
      list.appendChild(button);
    }

    const actions = platform.document.createElement("div");
    actions.className = "directory-browser-actions";
    actions.appendChild(feature.directoryBrowserButton("Host Default", () => feature.chooseDirectory("")));
    actions.appendChild(feature.directoryBrowserButton("Use This Folder", () => feature.chooseDirectory(data.path || "")));
    actions.appendChild(feature.directoryBrowserButton("Cancel", dependencies.menus().hideDirectoryBrowser));

    panel.appendChild(pathLine);
    panel.appendChild(nav);
    panel.appendChild(list);
    panel.appendChild(actions);
    feature.directoryBrowser.appendChild(panel);
  }

  function directoryBrowserPanel(titleText) {
    const panel = platform.document.createElement("div");
    panel.className = "directory-browser-panel";
    const title = platform.document.createElement("div");
    title.className = "directory-browser-title";
    title.textContent = titleText;
    panel.appendChild(title);
    return panel;
  }

  function directoryBrowserButton(label, action) {
    const button = platform.document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  function chooseDirectory(path) {
    if (feature.directoryBrowserRect) {
      dependencies.desktop().setPaneCwd(feature.directoryBrowserRect, path);
    }
    dependencies.menus().hideDirectoryBrowser();
  }

  function initializeDirectoryBrowserRect() {
    feature.directoryBrowserRect = null;
    feature.directoryBrowserPath = "";
  }

  function initializeDirectoryBrowser() {
    feature.directoryBrowser = platform.document.createElement("div");
    feature.directoryBrowser.className = "directory-browser";
    feature.directoryBrowser.hidden = true;
    platform.document.body.appendChild(feature.directoryBrowser);
  }

  Object.assign(feature, {
    openDirectoryBrowser,
    loadDirectoryBrowser,
    renderDirectoryBrowserLoading,
    renderDirectoryBrowserError,
    renderDirectoryBrowser,
    directoryBrowserPanel,
    directoryBrowserButton,
    chooseDirectory,
    initializeDirectoryBrowserRect,
    initializeDirectoryBrowser,
  });
  return feature;
}
