import { browserHelpAddress, browserLocalPortExamples, normalizeBrowserAddress } from "./browser-pane.mjs";

// Keyboard/Browser port help and modal presentation.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   browser: () => ReturnType<typeof import("./browser-view.mjs").createBrowser>,
 *   deskbar: () => ReturnType<typeof import("./deskbar.mjs").createDeskbar>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   palette: () => ReturnType<typeof import("./command-palette.mjs").createPalette>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createHelp(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    helpModal: undefined,
  };

  function openHelpModal() {
    dependencies.deskbar().hideDeskbar();
    feature.renderHelpModal();
    feature.helpModal.hidden = false;
    platform.window.requestAnimationFrame(() => feature.helpModal.querySelector("button")?.focus());
  }

  function openBrowserPortHelp(rect = null) {
    dependencies.deskbar().hideDeskbar();
    feature.renderBrowserPortHelp(rect?.kind === dependencies.browser().browserPaneKind ? rect : null);
    feature.helpModal.hidden = false;
    platform.window.requestAnimationFrame(() => feature.helpModal.querySelector(".browser-port-help-address")?.focus());
  }

  function hideHelpModal() {
    feature.helpModal.hidden = true;
    feature.helpModal.replaceChildren();
  }

  function renderBrowserPortHelp(targetRect) {
    feature.helpModal.replaceChildren();

    const panel = platform.document.createElement("section");
    panel.className = "settings-panel help-panel browser-port-help-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "browser-port-help-title");

    const titleBar = platform.document.createElement("div");
    titleBar.className = "settings-title";
    const title = platform.document.createElement("h2");
    title.id = "browser-port-help-title";
    title.textContent = "Browse a Local Port";
    const closeButton = platform.document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "settings-close";
    closeButton.textContent = "X";
    closeButton.setAttribute("aria-label", "Close local port help");
    closeButton.addEventListener("click", feature.hideHelpModal);
    titleBar.append(title, closeButton);

    const content = platform.document.createElement("div");
    content.className = "settings-content help-content browser-port-help-content";
    const introduction = platform.document.createElement("p");
    introduction.className = "browser-port-help-introduction";
    introduction.textContent = "Open an HTTP development server running on the Tessera host inside a sandboxed Browser pane. Tessera relays it; Tessera does not start the server.";
    content.appendChild(introduction);

    const launchForm = platform.document.createElement("form");
    launchForm.className = "browser-port-help-launch";
    const launchLabel = platform.document.createElement("label");
    launchLabel.htmlFor = "browser-port-help-address";
    launchLabel.textContent = "Local address";
    const address = platform.document.createElement("input");
    address.id = "browser-port-help-address";
    address.className = "browser-port-help-address";
    address.type = "text";
    address.spellcheck = false;
    address.value = browserHelpAddress(targetRect?.browserUrl);
    address.placeholder = "localhost:8080";
    const openButton = platform.document.createElement("button");
    openButton.type = "submit";
    openButton.className = "settings-background-button browser-port-help-open";
    openButton.textContent = "Open in Browser";
    const validation = platform.document.createElement("div");
    validation.className = "browser-port-help-validation";
    validation.setAttribute("role", "alert");
    validation.hidden = true;
    launchForm.append(launchLabel, address, openButton, validation);
    launchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const normalized = normalizeBrowserAddress(address.value);
      if (!normalized) {
        validation.textContent = "Enter a loopback HTTP address such as localhost:5000.";
        validation.hidden = false;
        address.setAttribute("aria-invalid", "true");
        address.focus();
        return;
      }
      validation.hidden = true;
      address.removeAttribute("aria-invalid");
      let destination = targetRect;
      if (!destination || !dependencies.desktop().rectangles.includes(destination) || !destination.browser) {
        const point = dependencies.desktop().paneSpawnPoint();
        destination = dependencies.desktop().createBrowserPane(point);
      }
      feature.hideHelpModal();
      void dependencies.browser().navigateBrowserPane(destination, normalized);
    });
    content.appendChild(launchForm);

    const quickStart = platform.document.createElement("section");
    quickStart.className = "settings-section";
    const quickStartTitle = platform.document.createElement("h3");
    quickStartTitle.textContent = "Quick start";
    const steps = platform.document.createElement("ol");
    steps.className = "browser-port-help-steps";
    for (const text of [
      "Start an HTTP development server on the same machine as Tessera.",
      "Enter localhost:<port> or an explicit loopback HTTP/HTTPS URL.",
      "Tessera opens it through a temporary path on its existing listener.",
    ]) {
      const step = platform.document.createElement("li");
      step.textContent = text;
      steps.appendChild(step);
    }
    quickStart.append(quickStartTitle, steps);
    content.appendChild(quickStart);

    const examples = platform.document.createElement("section");
    examples.className = "settings-section";
    const examplesTitle = platform.document.createElement("h3");
    examplesTitle.textContent = "Server examples";
    const exampleList = platform.document.createElement("div");
    exampleList.className = "browser-port-help-examples";
    for (const example of browserLocalPortExamples) {
      const row = platform.document.createElement("div");
      row.className = "browser-port-help-example";
      const label = platform.document.createElement("strong");
      label.textContent = example.label;
      const command = platform.document.createElement("code");
      command.textContent = example.command;
      const useButton = platform.document.createElement("button");
      useButton.type = "button";
      useButton.className = "settings-background-button";
      useButton.textContent = `Use ${example.address}`;
      useButton.addEventListener("click", () => {
        address.value = example.address;
        validation.hidden = true;
        address.removeAttribute("aria-invalid");
        address.focus();
      });
      row.append(label, command, useButton);
      exampleList.appendChild(row);
    }
    examples.append(examplesTitle, exampleList);
    content.appendChild(examples);

    content.appendChild(feature.renderHelpSection("Network boundary", [
      ["localhost / 127.0.0.1", "The app remains local to the Tessera host; remote access goes through Tessera's existing listener."],
      ["0.0.0.0", "The development server may already be directly reachable from other machines on the network."],
      ["Additional ports", "Tessera opens no new listening port; it uses a randomized path on its current HTTP address."],
    ]));
    content.appendChild(feature.renderHelpSection("Compatibility notes", [
      ["Usually works", "Relative assets, forms, fetch, XHR, WebSockets, EventSource, and same-origin redirects."],
      ["May need app changes", "Cookie authentication, service workers, strict origin checks, cross-origin redirects, and unusual URL construction."],
    ]));

    panel.append(titleBar, content);
    feature.helpModal.appendChild(panel);
  }

  function renderHelpModal() {
    feature.helpModal.replaceChildren();

    const panel = platform.document.createElement("section");
    panel.className = "settings-panel help-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "help-title");

    const titleBar = platform.document.createElement("div");
    titleBar.className = "settings-title";
    const title = platform.document.createElement("h2");
    title.id = "help-title";
    title.textContent = "Help";
    const closeButton = platform.document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "settings-close";
    closeButton.textContent = "X";
    closeButton.setAttribute("aria-label", "Close help");
    closeButton.addEventListener("click", feature.hideHelpModal);
    titleBar.append(title, closeButton);

    const content = platform.document.createElement("div");
    content.className = "settings-content help-content";
    content.appendChild(feature.renderHelpSection("Window controls", [
      ["Draw a new window", "Left-drag empty desktop space, or middle-drag over any pane. Release to choose the window type; Escape cancels a middle drag."],
      ["Move an OLED window", "Right-click a pane border to arm Move mode, then left-drag the pane."],
      ["Move a standard window", "Drag its title tab."],
      ["Change the active title", "Run Set Window Title... from the command palette."],
      ["Destroy the active window", "Run Destroy Window from the command palette (code DD)."],
    ]));
    content.appendChild(feature.renderHelpSection("Keyboard shortcuts", [
      ["Command palette", "Ctrl/Cmd+K — search or type a code, ↑/↓ to select, Enter to run"],
      ["Window list", "Ctrl/Cmd+L"],
      ["Session list", "Ctrl/Cmd+;"],
      ["Find in terminal", "Cmd+F (Ctrl+Shift+F off an Apple keyboard) — Enter / Shift+Enter or Cmd+G / Cmd+Shift+G (F3 / Shift+F3) for older / newer, Escape to close"],
      ["Next / previous window", "Ctrl/Cmd+] / Ctrl/Cmd+["],
      ["Move window earlier / later", "Ctrl/Cmd+Shift+↑ / Ctrl/Cmd+Shift+↓"],
      ["Reorder highlighted window in Window List", "Ctrl/Cmd+↑ / Ctrl/Cmd+↓"],
      ["Maximize / restore", "Alt+F10"],
      ["Minimize / restore", "Alt+F9"],
      ["Cascade / restore arrangement", "Alt+F7"],
    ]));

    const commands = dependencies.palette().buildPaletteCommands();
    dependencies.palette().assignPaletteShortcutCodes(commands);
    const commandSection = platform.document.createElement("section");
    commandSection.className = "settings-section";
    const commandHeading = platform.document.createElement("h3");
    commandHeading.textContent = "Command palette";
    commandSection.appendChild(commandHeading);
    const commandList = platform.document.createElement("div");
    commandList.className = "help-command-list";
    for (const command of commands) {
      const row = platform.document.createElement("div");
      row.className = "help-command-row";
      const label = platform.document.createElement("span");
      label.textContent = command.label;
      const code = platform.document.createElement("kbd");
      code.textContent = command.code || "—";
      const hint = platform.document.createElement("span");
      hint.textContent = command.hint || "";
      row.append(label, code, hint);
      commandList.appendChild(row);
    }
    commandSection.appendChild(commandList);
    content.appendChild(commandSection);

    panel.append(titleBar, content);
    feature.helpModal.appendChild(panel);
  }

  function renderHelpSection(titleText, entries) {
    const section = platform.document.createElement("section");
    section.className = "settings-section";
    const title = platform.document.createElement("h3");
    title.textContent = titleText;
    section.appendChild(title);
    const list = platform.document.createElement("div");
    list.className = "help-shortcut-list";
    for (const [labelText, valueText] of entries) {
      const row = platform.document.createElement("div");
      row.className = "help-shortcut-row";
      const label = platform.document.createElement("span");
      label.textContent = labelText;
      const value = platform.document.createElement("span");
      value.textContent = valueText;
      row.append(label, value);
      list.appendChild(row);
    }
    section.appendChild(list);
    return section;
  }

  function initializeHelpModal() {
    feature.helpModal = platform.document.createElement("div");
    feature.helpModal.className = "settings-modal help-modal";
    feature.helpModal.hidden = true;
    feature.helpModal.addEventListener("pointerdown", (event) => {
      if (event.target === feature.helpModal) {
        feature.hideHelpModal();
      }
    });
    platform.document.body.appendChild(feature.helpModal);
  }

  Object.assign(feature, {
    openHelpModal,
    openBrowserPortHelp,
    hideHelpModal,
    renderBrowserPortHelp,
    renderHelpModal,
    renderHelpSection,
    initializeHelpModal,
  });
  return feature;
}
