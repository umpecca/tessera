

// Workspace background upload, compression and display modes.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   settings: () => ReturnType<typeof import("./settings-view.mjs").createSettings>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createBackground(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    workspaceHasBackground: undefined,
    workspaceBackgroundVersion: undefined,
    workspaceBackgroundMode: undefined,
    backgroundRequestID: undefined,
    maxBackgroundBytes: undefined,
    targetBackgroundBytes: undefined,
    maxBackgroundDimension: undefined,
    backgroundDisplayModes: undefined,
    backgroundFileInput: undefined,
  };

  function normalizeBackgroundDisplayMode(mode) {
    return feature.backgroundDisplayModes[mode] ? mode : "fill";
  }

  function backgroundURL(version) {
    return feature.backgroundURLFor(dependencies.navigation().workspaceID, version);
  }

  function backgroundURLFor(id, version) {
    const base = `/api/workspace/${encodeURIComponent(id)}/background`;
    return version ? `${base}?v=${encodeURIComponent(version)}` : base;
  }

  // applyWorkspaceBackground sets or clears the board's background image layer.
  // The image renders beneath the theme's overlay (see .board in styles.css).
  function applyWorkspaceBackground(has, version, mode = feature.workspaceBackgroundMode) {
    feature.workspaceHasBackground = Boolean(has);
    feature.workspaceBackgroundVersion = version || "";
    feature.workspaceBackgroundMode = feature.normalizeBackgroundDisplayMode(mode);
    if (feature.workspaceHasBackground) {
      dependencies.desktop().board.style.setProperty("--board-user-image", `url("${feature.backgroundURL(feature.workspaceBackgroundVersion)}")`);
      dependencies.desktop().board.style.setProperty("--board-user-size", feature.backgroundDisplayModes[feature.workspaceBackgroundMode].size);
    } else {
      dependencies.desktop().board.style.removeProperty("--board-user-image");
      dependencies.desktop().board.style.removeProperty("--board-user-size");
    }
    // The background controls live in the Settings modal; if it's open when a
    // set/clear finishes, refresh it so the button labels stay in sync.
    if (!dependencies.settings().settingsModal.hidden) {
      dependencies.settings().renderSettingsModal();
    }
  }

  function handleBackgroundFileChange(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (file) {
      void feature.uploadBackground(file);
    }
  }

  function canvasJPEG(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("could not encode image"));
        }
      }, "image/jpeg", quality);
    });
  }

  async function compressBackgroundImage(file) {
    const source = await platform.createImageBitmap(file);
    try {
      let scale = Math.min(1, feature.maxBackgroundDimension / Math.max(source.width, source.height));
      let quality = 0.88;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const width = Math.max(1, Math.round(source.width * scale));
        const height = Math.max(1, Math.round(source.height * scale));
        const canvas = platform.document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) {
          throw new Error("could not prepare image canvas");
        }
        context.fillStyle = "#000000";
        context.fillRect(0, 0, width, height);
        context.drawImage(source, 0, 0, width, height);
        const jpeg = await feature.canvasJPEG(canvas, quality);
        if (jpeg.size <= feature.targetBackgroundBytes) {
          return jpeg;
        }
        if (quality > 0.5) {
          quality -= 0.1;
        } else {
          scale *= 0.75;
          quality = 0.85;
        }
      }
    } finally {
      source.close();
    }
    throw new Error("could not compress image below the upload limit");
  }

  async function uploadBackground(file) {
    if (!file.type.startsWith("image/")) {
      dependencies.workspace().setWorkspaceStatus("error", "Not an image", "Background must be an image file");
      return;
    }
    const targetWorkspaceID = dependencies.navigation().workspaceID;
    const requestID = ++feature.backgroundRequestID;
    try {
      dependencies.workspace().setWorkspaceStatus("saving", "Preparing image...");
      const jpeg = await feature.compressBackgroundImage(file);
      if (requestID !== feature.backgroundRequestID || dependencies.navigation().workspaceID !== targetWorkspaceID) return;
      if (jpeg.size > feature.maxBackgroundBytes) {
        throw new Error("compressed image is still too large");
      }
      dependencies.workspace().setWorkspaceStatus("saving", "Saving...");
      const response = await platform.fetch(feature.backgroundURLFor(targetWorkspaceID, ""), {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: jpeg,
      });
      if (!response.ok) {
        throw new Error(`set background failed: ${response.status}`);
      }
      const data = await response.json().catch(() => ({}));
      if (requestID !== feature.backgroundRequestID || dependencies.navigation().workspaceID !== targetWorkspaceID) return;
      feature.applyWorkspaceBackground(true, data.version || String(platform.Date.now()), feature.workspaceBackgroundMode);
      dependencies.workspace().setWorkspaceStatus("saved", "Saved", "Background updated");
    } catch (error) {
      if (requestID !== feature.backgroundRequestID || dependencies.navigation().workspaceID !== targetWorkspaceID) return;
      platform.console.warn(error);
      dependencies.workspace().setWorkspaceStatus("error", "Save failed", error.message || "Background save failed");
    }
  }

  async function clearBackground() {
    const targetWorkspaceID = dependencies.navigation().workspaceID;
    const requestID = ++feature.backgroundRequestID;
    dependencies.workspace().setWorkspaceStatus("saving", "Saving...");
    try {
      const response = await platform.fetch(feature.backgroundURLFor(targetWorkspaceID, ""), { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        throw new Error(`clear background failed: ${response.status}`);
      }
      if (requestID !== feature.backgroundRequestID || dependencies.navigation().workspaceID !== targetWorkspaceID) return;
      feature.applyWorkspaceBackground(false, "", feature.workspaceBackgroundMode);
      dependencies.workspace().setWorkspaceStatus("saved", "Saved", "Background cleared");
    } catch (error) {
      if (requestID !== feature.backgroundRequestID || dependencies.navigation().workspaceID !== targetWorkspaceID) return;
      platform.console.warn(error);
      dependencies.workspace().setWorkspaceStatus("error", "Clear failed", error.message || "Background clear failed");
    }
  }

  function setWorkspaceBackgroundMode(mode) {
    feature.workspaceBackgroundMode = feature.normalizeBackgroundDisplayMode(mode);
    if (feature.workspaceHasBackground) {
      dependencies.desktop().board.style.setProperty("--board-user-size", feature.backgroundDisplayModes[feature.workspaceBackgroundMode].size);
    }
    dependencies.workspace().scheduleWorkspaceSave();
  }

  function initializeWorkspaceHasBackground() {
    feature.workspaceHasBackground = false;
    feature.workspaceBackgroundVersion = "";
    feature.workspaceBackgroundMode = "fill";
    feature.backgroundRequestID = 0;
  }

  function initializeMaxBackgroundBytes() {
    feature.maxBackgroundBytes = 10 * 1024 * 1024;
    feature.targetBackgroundBytes = Math.floor(feature.maxBackgroundBytes * 0.9);
    feature.maxBackgroundDimension = 3840;
    feature.backgroundDisplayModes = {
      fill: { label: "Fill", size: "cover" },
      fit: { label: "Fit", size: "contain" },
      stretch: { label: "Stretch", size: "100% 100%" },
      center: { label: "Center", size: "auto" },
    };
  }

  function initializeBackgroundFileInput() {
    feature.backgroundFileInput = platform.document.createElement("input");
    feature.backgroundFileInput.type = "file";
    feature.backgroundFileInput.accept = "image/*";
    feature.backgroundFileInput.hidden = true;
    feature.backgroundFileInput.addEventListener("change", feature.handleBackgroundFileChange);
    platform.document.body.appendChild(feature.backgroundFileInput);
  }

  Object.assign(feature, {
    normalizeBackgroundDisplayMode,
    backgroundURL,
    backgroundURLFor,
    applyWorkspaceBackground,
    handleBackgroundFileChange,
    canvasJPEG,
    compressBackgroundImage,
    uploadBackground,
    clearBackground,
    setWorkspaceBackgroundMode,
    initializeWorkspaceHasBackground,
    initializeMaxBackgroundBytes,
    initializeBackgroundFileInput,
  });
  return feature;
}
