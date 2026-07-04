import {
  basicSetup,
  EditorSelection,
  EditorView,
  Prec,
  Transaction,
  keymap,
} from "./vendor/codemirror.js?v=run-fixes-4";

const board = document.querySelector("#board");
const tabHeight = 24;
const rectangles = [];
let activeRect = null;
let activePaneID = "";
let interaction = null;
let nextZIndex = 1;
let contextMenuRect = null;
let editorMenuRect = null;
let workspaceMenuPoint = null;
let windowTypeRect = null;
let directoryBrowserRect = null;
let directoryBrowserPath = "";
let editorClipboardText = "";
let workspaceID = "default";
let isLoadingWorkspace = false;
let saveTimer = null;
let saveRevision = 0;
const runStreamControllers = new Map();
let ghosttyModulePromise = null;
const terminalTextEncoder = new TextEncoder();

const tesseraEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    background: "transparent",
    color: "#1f1f1b",
  },
  ".cm-scroller": {
    fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
    fontSize: "14px",
    lineHeight: "1.42",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "10px 12px",
    caretColor: "#1f1f1b",
  },
  ".cm-gutters": {
    backgroundColor: "rgba(235, 232, 222, 0.72)",
    color: "#68645b",
    borderRight: "1px solid #c4c0b8",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(255, 255, 255, 0.34)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "rgba(255, 255, 255, 0.5)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "rgba(36, 95, 110, 0.24)",
  },
});

const commandSpinnerFrames = ["\u25f0", "\u25f3", "\u25f2", "\u25f1"];
const commandSpinnerIntervalMs = 120;


const freeCursorExtension = Prec.highest([
  keymap.of([
    { key: "ArrowUp", run: (view) => moveFreeCursorVertically(view, -1), preventDefault: true },
    { key: "ArrowDown", run: (view) => moveFreeCursorVertically(view, 1), preventDefault: true },
    { key: "ArrowRight", run: moveFreeCursorRight, preventDefault: true },
  ]),
  EditorView.domEventHandlers({
    mousedown(event, view) {
      return moveFreeCursorFromMouse(view, event);
    },
  }),
]);

const dockMenu = document.createElement("div");
dockMenu.className = "dock-menu";
dockMenu.hidden = true;
document.body.appendChild(dockMenu);

const editorMenu = document.createElement("div");
editorMenu.className = "dock-menu editor-menu";
editorMenu.hidden = true;
document.body.appendChild(editorMenu);

const workspaceMenu = document.createElement("div");
workspaceMenu.className = "dock-menu workspace-menu";
workspaceMenu.hidden = true;
document.body.appendChild(workspaceMenu);

const windowTypeMenu = document.createElement("div");
windowTypeMenu.className = "dock-menu window-type-menu";
windowTypeMenu.hidden = true;
document.body.appendChild(windowTypeMenu);

const directoryBrowser = document.createElement("div");
directoryBrowser.className = "directory-browser";
directoryBrowser.hidden = true;
document.body.appendChild(directoryBrowser);

const workspaceStatus = document.createElement("div");
workspaceStatus.className = "workspace-status";
workspaceStatus.setAttribute("role", "status");
workspaceStatus.setAttribute("aria-live", "polite");
workspaceStatus.dataset.state = "idle";
workspaceStatus.textContent = "Loading...";
document.body.appendChild(workspaceStatus);

board.addEventListener("pointerdown", startDrawing);
board.addEventListener("contextmenu", openWorkspaceMenu);
document.addEventListener("pointerdown", hideMenusWhenOutside);
document.addEventListener("keydown", hideMenusOnEscape);
document.addEventListener("keydown", handlePaneKeyboardShortcuts);
window.addEventListener("pointermove", continueInteraction);
window.addEventListener("pointerup", finishInteraction);
window.addEventListener("pointercancel", finishInteraction);
window.addEventListener("resize", hideAllMenus);

loadWorkspace();

function startDrawing(event) {
  if (event.button !== 0 || event.target !== board) {
    return;
  }
  event.preventDefault();
  hideAllMenus();

  const point = boardPoint(event);
  const rect = createRectangle(point.x, point.y, 1, 1, {
    kind: "pending",
    cwd: activeRect?.cwd || "",
  });
  setActivePane(rect, { raise: true });

  interaction = {
    type: "draw",
    id: event.pointerId,
    rect,
    startX: point.x,
    startY: point.y,
  };
  board.setPointerCapture(event.pointerId);
}

function startMoving(event, rect) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  clearFullState(rect);
  setActivePane(rect, { raise: true });

  const point = boardPoint(event);
  interaction = {
    type: "move",
    id: event.pointerId,
    rect,
    startX: point.x,
    startY: point.y,
    original: { ...rect },
  };
  rect.element.setPointerCapture(event.pointerId);
}

function startResizing(event, rect, handle) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  clearFullState(rect);
  setActivePane(rect, { raise: true });

  const point = boardPoint(event);
  interaction = {
    type: "resize",
    id: event.pointerId,
    rect,
    handle,
    startX: point.x,
    startY: point.y,
    original: { ...rect },
  };
  rect.element.setPointerCapture(event.pointerId);
}

function continueInteraction(event) {
  if (!interaction || interaction.id !== event.pointerId) {
    return;
  }

  const point = boardPoint(event);
  if (interaction.type === "draw") {
    const box = boxFromDrag(interaction.startX, interaction.startY, point.x, point.y, event.shiftKey);
    clampIntoBoard(box);
    setRectangle(interaction.rect, box);
    return;
  }

  if (interaction.type === "move") {
    const dx = point.x - interaction.startX;
    const dy = point.y - interaction.startY;
    const next = {
      ...interaction.original,
      x: interaction.original.x + dx,
      y: interaction.original.y + dy,
    };
    clampIntoBoard(next);
    setRectangle(interaction.rect, next);
    return;
  }

  if (interaction.type === "resize") {
    const next = resizeBox(interaction.original, interaction.handle, point.x - interaction.startX, point.y - interaction.startY, event.shiftKey);
    clampIntoBoard(next);
    setRectangle(interaction.rect, next);
  }
}

function finishInteraction(event) {
  if (!interaction || interaction.id !== event.pointerId) {
    return;
  }

  const finishedInteraction = interaction;
  interaction = null;

  if (finishedInteraction.type === "draw") {
    if (finishedInteraction.rect.width < 6 || finishedInteraction.rect.height < 6) {
      destroyRectangle(finishedInteraction.rect);
      return;
    }
    showWindowTypeMenu(finishedInteraction.rect, event.clientX, event.clientY);
  }
}

function createRectangle(x, y, width, height, options = {}) {
  const element = document.createElement("div");
  element.className = "rectangle";
  element.dataset.paneId = options.id || "";
  element.tabIndex = -1;
  element.addEventListener("pointerdown", (event) => {
    if (event.target === element) {
      startMoving(event, rect);
    }
  });

  const rect = {
    id: options.id || newPaneID(),
    kind: options.kind || "worksheet",
    x,
    y,
    width,
    height,
    element,
    zIndex: options.zIndex || 0,
    title: options.title || (options.kind === "terminal" ? "Terminal" : ""),
    text: options.kind === "terminal" ? "" : (options.text || ""),
    cwd: options.cwd || "",
    running: false,
    runID: "",
    commandSpinner: null,
    terminal: null,
    terminalContainer: null,
    isFull: false,
    restoreBox: null,
  };
  element.dataset.paneId = rect.id;
  element.dataset.paneKind = rect.kind;
  const tab = document.createElement("div");
  tab.className = "window-tab";

  const grip = document.createElement("div");
  grip.className = "window-grip";
  grip.addEventListener("pointerdown", (event) => startMoving(event, rect));
  grip.addEventListener("contextmenu", (event) => openDockMenu(event, rect));

  const title = document.createElement("input");
  title.className = "window-title";
  title.type = "text";
  title.value = rect.title;
  title.spellcheck = false;
  title.setAttribute("aria-label", "Window title");
  title.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    setActivePane(rect, { raise: true });
  });
  title.addEventListener("input", () => {
    rect.title = title.value;
    scheduleWorkspaceSave();
  });

  const status = document.createElement("div");
  status.className = "window-status";

  const cwdLabel = document.createElement("span");
  cwdLabel.className = "window-status-label";
  cwdLabel.textContent = "cwd";

  const cwdInput = document.createElement("input");
  cwdInput.className = "window-cwd";
  cwdInput.type = "text";
  cwdInput.value = rect.cwd;
  cwdInput.placeholder = "host default";
  cwdInput.readOnly = true;
  cwdInput.spellcheck = false;
  cwdInput.setAttribute("aria-label", "Pane working directory");
  cwdInput.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setActivePane(rect, { raise: true });
    openDirectoryBrowser(rect, rect.cwd);
  });
  cwdInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      setActivePane(rect, { raise: true });
      openDirectoryBrowser(rect, rect.cwd);
    }
  });
  cwdInput.addEventListener("input", () => {
    setPaneCwd(rect, cwdInput.value, { fromField: true });
  });

  const body = document.createElement("div");
  body.className = "window-body";
  body.setAttribute("aria-label", rect.kind === "terminal" ? "Terminal" : rect.kind === "pending" ? "New window" : "Workspace text");
  body.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    setActivePane(rect, { raise: true });
    if (rect.kind === "terminal") {
      rect.terminal?.term?.focus();
    }
  });
  body.addEventListener("focusin", () => setActivePane(rect, { raise: true }));
  if (rect.kind === "worksheet") {
    body.addEventListener("contextmenu", (event) => openEditorMenu(event, rect));
  }

  tab.appendChild(grip);
  tab.appendChild(title);
  status.appendChild(cwdLabel);
  status.appendChild(cwdInput);
  element.appendChild(tab);
  element.appendChild(body);
  element.appendChild(status);
  rect.cwdInput = cwdInput;
  setPaneCwd(rect, rect.cwd, { silent: true });

  if (rect.kind === "terminal") {
    body.classList.add("is-terminal");
    const terminalContainer = document.createElement("div");
    terminalContainer.className = "terminal-container";
    body.appendChild(terminalContainer);
    rect.terminalContainer = terminalContainer;
    void startTerminal(rect);
  } else if (rect.kind === "worksheet") {
    rect.editor = new EditorView({
      doc: rect.text,
      extensions: [
        basicSetup,
        tesseraEditorTheme,
        freeCursorExtension,
        Prec.highest(keymap.of([
          { key: "Mod-Enter", run: () => runPaneCommand(rect), preventDefault: true },
          { key: "Ctrl-Enter", run: () => runPaneCommand(rect), preventDefault: true },
        ])),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const isSpinnerChange = update.transactions.every((transaction) => (
              transaction.annotation(Transaction.userEvent) === "input.tesseraSpinner"
            ));
            if (!isSpinnerChange) {
              rect.commandSpinner?.map(update.changes);
            }
            rect.text = rect.commandSpinner
              ? rect.commandSpinner.textWithoutSpinner(update.state.doc.toString())
              : update.state.doc.toString();
            if (!rect.running) {
              scheduleWorkspaceSave();
            }
          }
        }),
      ],
      parent: body,
    });
  } else {
    body.classList.add("is-pending");
  }

  for (const handle of ["nw", "ne", "se", "sw"]) {
    const node = document.createElement("div");
    node.className = `resize-handle handle-${handle}`;
    node.addEventListener("pointerdown", (event) => startResizing(event, rect, handle));
    element.appendChild(node);
  }

  rectangles.push(rect);
  board.appendChild(element);
  setRectangle(rect, rect);
  rect.element.style.zIndex = String(rect.zIndex);
  nextZIndex = Math.max(nextZIndex, rect.zIndex + 1);
  return rect;
}

function setActivePane(rect, options = {}) {
  if (!rect || !rectangles.includes(rect)) {
    clearActivePane();
    return;
  }
  const wasActive = activePaneID === rect.id;
  clearActivePaneClass();
  activeRect = rect;
  activePaneID = rect.id;
  board.dataset.activePaneId = activePaneID;
  rect.element.dataset.activePane = "true";
  rect.element.classList.add("is-selected");
  if (options.raise) {
    rect.zIndex = nextZIndex;
    nextZIndex += 1;
    rect.element.style.zIndex = String(rect.zIndex);
  }
  if (options.focusEditor) {
    if (rect.kind === "terminal") {
      rect.terminal?.term?.focus();
    } else {
      rect.editor?.focus();
    }
  } else if (options.focusElement) {
    rect.element.focus({ preventScroll: true });
  }
  if (!wasActive || options.raise) {
    scheduleWorkspaceSave();
  }
}

function clearActivePane() {
  clearActivePaneClass();
  activeRect = null;
  activePaneID = "";
  delete board.dataset.activePaneId;
  scheduleWorkspaceSave();
}

function clearActivePaneClass() {
  if (activeRect) {
    activeRect.element.classList.remove("is-selected");
    delete activeRect.element.dataset.activePane;
  }
}

function getActivePane() {
  return rectangles.find((rect) => rect.id === activePaneID) || null;
}

function setPaneCwd(rect, cwd, options = {}) {
  if (!rect) {
    return;
  }
  const nextCwd = cwd || "";
  const changed = rect.cwd !== nextCwd;
  rect.cwd = nextCwd;
  rect.element.dataset.cwd = nextCwd;
  if (rect.cwdInput && !options.fromField) {
    rect.cwdInput.value = nextCwd;
  }
  if (rect.cwdInput) {
    rect.cwdInput.title = nextCwd || "Use host default working directory";
  }
  if (changed && !options.silent) {
    scheduleWorkspaceSave();
  }
}

async function openDirectoryBrowser(rect, path) {
  if (!rect) {
    return;
  }
  directoryBrowserRect = rect;
  hideDockMenu();
  hideEditorMenu();
  directoryBrowser.hidden = false;
  renderDirectoryBrowserLoading(path || "");

  try {
    await loadDirectoryBrowser(path || "");
  } catch (error) {
    renderDirectoryBrowserError(error.message || "Could not load directory");
  }
}

async function loadDirectoryBrowser(path) {
  const url = path ? `/api/directories?path=${encodeURIComponent(path)}` : "/api/directories";
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `directory load failed: ${response.status}`);
  }
  directoryBrowserPath = data.path || "";
  renderDirectoryBrowser(data);
}

function renderDirectoryBrowserLoading(path) {
  directoryBrowser.replaceChildren();
  const panel = directoryBrowserPanel("Choose Working Directory");
  const pathLine = document.createElement("div");
  pathLine.className = "directory-browser-path";
  pathLine.textContent = path || "host default";
  const message = document.createElement("div");
  message.className = "directory-browser-message";
  message.textContent = "Loading...";
  panel.appendChild(pathLine);
  panel.appendChild(message);
  directoryBrowser.appendChild(panel);
}

function renderDirectoryBrowserError(messageText) {
  directoryBrowser.replaceChildren();
  const panel = directoryBrowserPanel("Choose Working Directory");
  const message = document.createElement("div");
  message.className = "directory-browser-message is-error";
  message.textContent = messageText;
  const actions = document.createElement("div");
  actions.className = "directory-browser-actions";
  actions.appendChild(directoryBrowserButton("Close", hideDirectoryBrowser));
  panel.appendChild(message);
  panel.appendChild(actions);
  directoryBrowser.appendChild(panel);
}

function renderDirectoryBrowser(data) {
  directoryBrowser.replaceChildren();
  const panel = directoryBrowserPanel("Choose Working Directory");

  const pathLine = document.createElement("div");
  pathLine.className = "directory-browser-path";
  pathLine.textContent = data.path || "host default";
  pathLine.title = data.path || "host default";

  const nav = document.createElement("div");
  nav.className = "directory-browser-nav";
  if (data.parent) {
    nav.appendChild(directoryBrowserButton("Up", () => loadDirectoryBrowser(data.parent)));
  }
  for (const root of data.roots || []) {
    nav.appendChild(directoryBrowserButton(root.name, () => loadDirectoryBrowser(root.path)));
  }

  const list = document.createElement("div");
  list.className = "directory-browser-list";
  if ((data.entries || []).length === 0) {
    const empty = document.createElement("div");
    empty.className = "directory-browser-message";
    empty.textContent = "No folders";
    list.appendChild(empty);
  }
  for (const entry of data.entries || []) {
    const button = directoryBrowserButton(entry.name, () => loadDirectoryBrowser(entry.path));
    button.className = "directory-browser-entry";
    button.title = entry.path;
    list.appendChild(button);
  }

  const actions = document.createElement("div");
  actions.className = "directory-browser-actions";
  actions.appendChild(directoryBrowserButton("Host Default", () => chooseDirectory("")));
  actions.appendChild(directoryBrowserButton("Use This Folder", () => chooseDirectory(data.path || "")));
  actions.appendChild(directoryBrowserButton("Cancel", hideDirectoryBrowser));

  panel.appendChild(pathLine);
  panel.appendChild(nav);
  panel.appendChild(list);
  panel.appendChild(actions);
  directoryBrowser.appendChild(panel);
}

function directoryBrowserPanel(titleText) {
  const panel = document.createElement("div");
  panel.className = "directory-browser-panel";
  const title = document.createElement("div");
  title.className = "directory-browser-title";
  title.textContent = titleText;
  panel.appendChild(title);
  return panel;
}

function directoryBrowserButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function chooseDirectory(path) {
  if (directoryBrowserRect) {
    setPaneCwd(directoryBrowserRect, path);
  }
  hideDirectoryBrowser();
}

function setRectangle(rect, next) {
  rect.x = Math.round(next.x);
  rect.y = Math.round(next.y);
  rect.width = Math.max(1, Math.round(next.width));
  rect.height = Math.max(1, Math.round(next.height));
  rect.element.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
  rect.element.style.width = `${rect.width}px`;
  rect.element.style.height = `${rect.height}px`;
  if (rect.editor) {
    rect.editor.requestMeasure();
  }
  requestTerminalFit(rect);
  scheduleWorkspaceSave();
}

async function loadWorkspace() {
  isLoadingWorkspace = true;
  setWorkspaceStatus("loading", "Loading...");
  try {
    const response = await fetch("/api/workspace/default");
    if (!response.ok) {
      throw new Error(`load workspace failed: ${response.status}`);
    }
    const workspace = await response.json();
    workspaceID = workspace.id || "default";
    clearRectanglesForLoad();

    let highestZIndex = 0;
    for (const pane of workspace.panes || []) {
      const rect = createRectangle(pane.x ?? 80, pane.y ?? tabHeight + 56, pane.width || 360, pane.height || 240, {
        id: pane.id,
        kind: pane.kind || "worksheet",
        title: pane.title,
        text: pane.bufferText,
        cwd: pane.cwd,
        zIndex: pane.zIndex || 0,
      });
      highestZIndex = Math.max(highestZIndex, rect.zIndex);
    }

    nextZIndex = Math.max(nextZIndex, highestZIndex + 1);
    const activeLoadedRect = rectangles.find((rect) => rect.id === workspace.activePaneId) || null;
    if (activeLoadedRect) {
      setActivePane(activeLoadedRect, { raise: false });
    }
    await syncRunningCommands();
    setWorkspaceStatus("saved", "Saved", "Workspace loaded");
  } catch (error) {
    console.warn(error);
    setWorkspaceStatus("error", "Load failed", error.message || "Workspace load failed");
  } finally {
    isLoadingWorkspace = false;
  }
}

function clearRectanglesForLoad() {
  stopRunStreams();
  for (const rect of rectangles.splice(0)) {
    disposeTerminal(rect);
    rect.editor?.destroy();
    rect.element.remove();
  }
  activeRect = null;
  activePaneID = "";
  delete board.dataset.activePaneId;
  interaction = null;
  contextMenuRect = null;
  editorMenuRect = null;
  hideAllMenus();
  nextZIndex = 1;
}

function scheduleWorkspaceSave() {
  if (isLoadingWorkspace) {
    return;
  }
  setWorkspaceStatus("saving", "Saving...");
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveWorkspace, 250);
}

async function flushWorkspaceSave() {
  if (isLoadingWorkspace) {
    return;
  }
  window.clearTimeout(saveTimer);
  saveTimer = null;
  await saveWorkspace();
}

async function saveWorkspace() {
  const revision = ++saveRevision;
  window.clearTimeout(saveTimer);
  saveTimer = null;
  setWorkspaceStatus("saving", "Saving...");
  const savedRectangles = rectangles.filter((rect) => rect.kind !== "pending");
  const panes = savedRectangles.map((rect, index) => ({
    id: rect.id,
    title: rect.title,
    kind: rect.kind,
    bufferText: rect.kind === "terminal" ? "" : rect.text,
    cwd: rect.cwd || "",
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    zIndex: rect.zIndex,
    position: index,
  }));

  try {
    const response = await fetch("/api/workspace/default", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: workspaceID,
        name: "Default",
        activePaneId: savedRectangles.some((rect) => rect.id === activePaneID) ? activePaneID : "",
        layout: { panes: panes.map((pane) => pane.id) },
        panes,
      }),
    });
    if (!response.ok) {
      throw new Error(`save workspace failed: ${response.status}`);
    }
    if (revision === saveRevision && saveTimer === null) {
      setWorkspaceStatus("saved", "Saved");
    }
  } catch (error) {
    if (revision === saveRevision && saveTimer === null) {
      console.warn(error);
      setWorkspaceStatus("error", "Save failed", error.message || "Workspace save failed");
    }
  }
}

function setWorkspaceStatus(state, text, title = "") {
  workspaceStatus.dataset.state = state;
  workspaceStatus.textContent = text;
  workspaceStatus.title = title || text;
}

async function syncRunningCommands() {
  try {
    const response = await fetch(`/api/runs?workspaceId=${encodeURIComponent(workspaceID)}`);
    if (!response.ok) {
      throw new Error(`load runs failed: ${response.status}`);
    }
    const data = await response.json();
    for (const run of data.runs || []) {
      const rect = rectangles.find((candidate) => candidate.id === run.paneId);
      if (!rect || runStreamControllers.has(run.runId)) {
        continue;
      }
      markPaneRunning(rect, run.runId);
      subscribeToRun(rect, run.runId);
    }
  } catch (error) {
    console.warn(error);
  }
}

function subscribeToRun(rect, runID) {
  const controller = new AbortController();
  runStreamControllers.set(runID, controller);
  void (async () => {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runID)}/events`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`subscribe run failed: ${response.status}`);
      }
      await readRunEventStream(response, (event) => applyRunEvent(rect, event));
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn(error);
      }
    } finally {
      runStreamControllers.delete(runID);
      if (!controller.signal.aborted && rect.runID === runID) {
        clearPaneRunning(rect);
      }
    }
  })();
}

function stopRunStreams() {
  for (const controller of runStreamControllers.values()) {
    controller.abort();
  }
  runStreamControllers.clear();
}

function loadGhosttyModule() {
  if (!ghosttyModulePromise) {
    ghosttyModulePromise = import("./vendor/terminal.js?v=terminal-1").then(async (module) => {
      await module.init();
      return module;
    });
  }
  return ghosttyModulePromise;
}

async function startTerminal(rect) {
  if (!rect?.terminalContainer || rect.terminal) {
    return;
  }

  rect.terminalContainer.textContent = "Starting terminal...";
  try {
    const { FitAddon, Terminal } = await loadGhosttyModule();
    if (!rect.terminalContainer || rect.kind !== "terminal") {
      return;
    }

    rect.terminalContainer.replaceChildren();
    const term = new Terminal({
      cols: 80,
      rows: 24,
      fontSize: 14,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      cursorBlink: true,
      theme: {
        background: "#10141c",
        foreground: "#e5e1d5",
        cursor: "#f4df45",
        selectionBackground: "#284461",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(rect.terminalContainer);
    fit.fit();
    fit.observeResize();

    const socket = new WebSocket(terminalWebSocketURL(rect, term.cols, term.rows));
    socket.binaryType = "arraybuffer";
    const dataDisposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(terminalTextEncoder.encode(data));
      }
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      sendTerminalResize(socket, cols, rows);
    });

    socket.addEventListener("open", () => {
      setPaneCwd(rect, rect.cwd, { silent: true });
      sendTerminalResize(socket, term.cols, term.rows);
      term.focus();
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        term.write(event.data);
        return;
      }
      term.write(new Uint8Array(event.data));
    });
    socket.addEventListener("close", () => {
      if (rect.terminal?.socket === socket) {
        term.write("\r\n[tessera terminal disconnected]\r\n");
      }
    });
    socket.addEventListener("error", () => {
      term.write("\r\n[tessera terminal connection error]\r\n");
    });

    rect.terminal = { term, fit, socket, dataDisposable, resizeDisposable };
    requestTerminalFit(rect);
  } catch (error) {
    console.warn(error);
    if (rect.terminalContainer) {
      rect.terminalContainer.textContent = error.message || "Terminal failed to start";
    }
  }
}

function terminalWebSocketURL(rect, cols, rows) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({
    paneId: rect.id,
    cwd: rect.cwd || "",
    cols: String(cols || 80),
    rows: String(rows || 24),
  });
  return `${protocol}//${window.location.host}/api/terminal?${params.toString()}`;
}

function sendTerminalResize(socket, cols, rows) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({
    type: "resize",
    cols,
    rows,
  }));
}

function requestTerminalFit(rect) {
  if (!rect?.terminal?.fit) {
    return;
  }
  window.requestAnimationFrame(() => {
    if (!rect.terminal?.fit) {
      return;
    }
    rect.terminal.fit.fit();
    sendTerminalResize(rect.terminal.socket, rect.terminal.term.cols, rect.terminal.term.rows);
  });
}

function disposeTerminal(rect, options = {}) {
  if (!rect?.terminal) {
    if (options.closeServer && rect?.kind === "terminal") {
      closeServerTerminal(rect);
    }
    return;
  }
  const terminalState = rect.terminal;
  rect.terminal = null;
  if (options.closeServer) {
    closeServerTerminal(rect);
  }
  terminalState.dataDisposable?.dispose?.();
  terminalState.resizeDisposable?.dispose?.();
  terminalState.fit?.dispose?.();
  terminalState.term?.dispose?.();
  if (terminalState.socket?.readyState === WebSocket.OPEN || terminalState.socket?.readyState === WebSocket.CONNECTING) {
    terminalState.socket.close();
  }
}

function closeServerTerminal(rect) {
  if (!rect?.id) {
    return;
  }
  fetch(`/api/terminal?paneId=${encodeURIComponent(rect.id)}`, {
    method: "DELETE",
    keepalive: true,
  }).catch((error) => console.warn(error));
}

function newPaneID() {
  if (crypto.randomUUID) {
    return `pane-${crypto.randomUUID()}`;
  }
  return `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function moveFreeCursorFromMouse(view, event) {
  if (event.button !== 0 || event.detail !== 1 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }

  const target = freeCursorMouseTarget(view, event);
  if (!target) {
    return false;
  }

  event.preventDefault();
  return moveCursorToMaterializedColumn(view, target.lineNumber, target.column, "select.freeCursor");
}

function moveFreeCursorVertically(view, direction) {
  const selection = view.state.selection;
  const range = selection.main;
  if (!range.empty || selection.ranges.length > 1) {
    return false;
  }

  const line = view.state.doc.lineAt(range.head);
  const targetLineNumber = line.number + direction;
  if (targetLineNumber < 1) {
    return false;
  }

  return moveCursorToMaterializedColumn(view, targetLineNumber, range.head - line.from, "select.freeCursor");
}

function moveFreeCursorRight(view) {
  const selection = view.state.selection;
  const range = selection.main;
  if (!range.empty || selection.ranges.length > 1) {
    return false;
  }

  const line = view.state.doc.lineAt(range.head);
  if (range.head !== line.to) {
    return false;
  }

  return moveCursorToMaterializedColumn(view, line.number, line.length + 1, "input.freeCursor");
}

function freeCursorMouseTarget(view, event) {
  const lineHeight = Math.max(1, view.defaultLineHeight || 16);
  const doc = view.state.doc;
  const lineNumber = Math.max(1, Math.floor((event.clientY - view.documentTop) / lineHeight) + 1);

  if (lineNumber > doc.lines) {
    const column = mouseColumnAtLineStart(view, event.clientX, doc.line(doc.lines));
    return { lineNumber, column };
  }

  const line = doc.line(lineNumber);
  const column = mouseColumnAtLineStart(view, event.clientX, line);
  if (column <= line.length) {
    return null;
  }

  return { lineNumber, column };
}

function mouseColumnAtLineStart(view, clientX, line) {
  const charWidth = Math.max(1, view.defaultCharacterWidth || 8);
  const lineStart = view.coordsAtPos(line.from, 1) || view.coordsAtPos(line.to, -1);
  const contentBox = view.contentDOM.getBoundingClientRect();
  const textLeft = lineStart?.left ?? contentBox.left;
  return Math.max(0, Math.round((clientX - textLeft) / charWidth));
}

function moveCursorToMaterializedColumn(view, lineNumber, column, userEvent) {
  const state = view.state;
  const targetLineNumber = Math.max(1, lineNumber);
  const targetColumn = Math.max(0, column);

  if (targetLineNumber > state.doc.lines) {
    const missingLines = targetLineNumber - state.doc.lines;
    const insert = "\n".repeat(missingLines) + " ".repeat(targetColumn);
    const anchor = state.doc.length + missingLines + targetColumn;
    view.dispatch({
      changes: { from: state.doc.length, insert },
      selection: EditorSelection.cursor(anchor),
      scrollIntoView: true,
      userEvent,
    });
    view.focus();
    return true;
  }

  const line = state.doc.line(targetLineNumber);
  const padding = Math.max(0, targetColumn - line.length);
  const anchor = line.from + targetColumn;
  const transaction = {
    selection: EditorSelection.cursor(anchor),
    scrollIntoView: true,
    userEvent,
  };

  if (padding > 0) {
    transaction.changes = {
      from: line.to,
      insert: " ".repeat(padding),
    };
  }

  view.dispatch(transaction);
  view.focus();
  return true;
}

function openDockMenu(event, rect) {
  event.preventDefault();
  event.stopPropagation();
  if (rect.kind === "pending") {
    hideWindowTypeMenu({ finalizeDefault: false });
    finalizePendingRectangle(rect, "worksheet");
    return;
  }
  setActivePane(rect, { raise: true });
  hideEditorMenu();
  hideWorkspaceMenu();
  hideWindowTypeMenu();
  contextMenuRect = rect;
  renderDockMenu(rect);
  showMenuAt(dockMenu, event.clientX, event.clientY);
}

function openEditorMenu(event, rect) {
  event.preventDefault();
  event.stopPropagation();
  setActivePane(rect, { raise: true });
  hideDockMenu();
  hideWorkspaceMenu();
  hideWindowTypeMenu();
  editorMenuRect = rect;
  renderEditorMenu(rect);
  showMenuAt(editorMenu, event.clientX, event.clientY);
}

function openWorkspaceMenu(event) {
  if (event.target !== board) {
    return;
  }
  event.preventDefault();
  workspaceMenuPoint = boardPoint(event);
  hideDockMenu();
  hideEditorMenu();
  hideWindowTypeMenu();
  renderWorkspaceMenu();
  showMenuAt(workspaceMenu, event.clientX, event.clientY);
}

function renderDockMenu(rect) {
  dockMenu.replaceChildren();
  const actions = [
    ["top", "Dock Top"],
    ["left", "Dock Left"],
    ["right", "Dock Right"],
    ["bottom", "Dock Bottom"],
    [rect.isFull ? "restore" : "full", rect.isFull ? "Restore" : "Full"],
    ["destroy", "Destroy"],
  ];

  for (const [action, label] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (action === "destroy") {
      button.className = "is-danger";
    }
    button.addEventListener("click", () => {
      applyDockAction(action, contextMenuRect);
      hideDockMenu();
    });
    dockMenu.appendChild(button);
  }
}

function renderWorkspaceMenu() {
  workspaceMenu.replaceChildren();

  const terminalButton = document.createElement("button");
  terminalButton.type = "button";
  terminalButton.textContent = "New Terminal";
  terminalButton.className = "is-command";
  terminalButton.addEventListener("click", () => {
    const point = workspaceMenuPoint || { x: 80, y: tabHeight + 56 };
    hideWorkspaceMenu();
    createTerminalPane(point.x, point.y);
  });
  workspaceMenu.appendChild(terminalButton);

  const panes = rectangles.filter((rect) => rect.kind !== "pending").sort((a, b) => b.zIndex - a.zIndex);
  if (panes.length === 0) {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.textContent = "No windows";
    empty.disabled = true;
    workspaceMenu.appendChild(empty);
    return;
  }

  for (const rect of panes) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = workspaceMenuLabel(rect);
    button.title = rect.cwd ? `${button.textContent} (${rect.cwd})` : button.textContent;
    if (rect.id === activePaneID) {
      button.className = "is-active";
    }
    button.addEventListener("click", () => {
      hideWorkspaceMenu();
      setActivePane(rect, { raise: true, focusEditor: true });
    });
    workspaceMenu.appendChild(button);
  }
}

function showWindowTypeMenu(rect, clientX, clientY) {
  if (!rect || rect.kind !== "pending" || !rectangles.includes(rect)) {
    return;
  }
  hideDockMenu();
  hideEditorMenu();
  hideWorkspaceMenu();
  hideDirectoryBrowser();
  windowTypeRect = rect;
  renderWindowTypeMenu();
  showMenuAt(windowTypeMenu, clientX, clientY);
}

function renderWindowTypeMenu() {
  windowTypeMenu.replaceChildren();
  const actions = [
    ["worksheet", "Worksheet"],
    ["terminal", "Terminal"],
  ];
  for (const [kind, label] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      const rect = windowTypeRect;
      hideWindowTypeMenu({ finalizeDefault: false });
      finalizePendingRectangle(rect, kind);
    });
    windowTypeMenu.appendChild(button);
  }
}

function finalizePendingRectangle(rect, kind) {
  if (!rect || rect.kind !== "pending" || !rectangles.includes(rect)) {
    return;
  }
  const paneKind = kind === "terminal" ? "terminal" : "worksheet";
  const box = rectangleBox(rect);
  const paneID = rect.id;
  const zIndex = rect.zIndex;
  const cwd = rect.cwd || "";
  destroyRectangle(rect);
  const nextRect = createRectangle(box.x, box.y, box.width, box.height, {
    id: paneID,
    kind: paneKind,
    title: paneKind === "terminal" ? "Terminal" : "",
    cwd,
    zIndex,
  });
  setActivePane(nextRect, { raise: true, focusEditor: true });
  scheduleWorkspaceSave();
}

function workspaceMenuLabel(rect) {
  const index = rectangles.indexOf(rect);
  const name = rect.title.trim() || `Window ${index + 1}`;
  const kindSuffix = rect.kind === "terminal" ? " [terminal]" : "";
  const activePrefix = rect.id === activePaneID ? "> " : "";
  const runningSuffix = rect.running ? " !" : "";
  return `${activePrefix}${name}${kindSuffix}${runningSuffix}`;
}

function createTerminalPane(x, y) {
  const rect = createRectangle(x, Math.max(y, tabHeight), 640, 360, {
    kind: "terminal",
    title: "Terminal",
    cwd: activeRect?.cwd || "",
  });
  clampIntoBoard(rect);
  setRectangle(rect, rect);
  setActivePane(rect, { raise: true, focusEditor: true });
  scheduleWorkspaceSave();
}

function renderEditorMenu(rect) {
  editorMenu.replaceChildren();
  const actions = [
    ["run", "Run"],
    ["copy", "Copy"],
    ["cut", "Cut"],
    ["paste", "Paste"],
  ];
  const hasSelection = hasEditorSelection(rect.editor);
  const canRun = Boolean(commandTargetForEditor(rect.editor)) && !rect.running;
  const canReadClipboard = Boolean(navigator.clipboard?.readText || document.queryCommandSupported?.("paste"));
  const canPaste = canReadClipboard || editorClipboardText.length > 0;

  for (const [action, label] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.action = action;
    if (action === "run") {
      button.disabled = !canRun;
    } else if (action === "copy" || action === "cut") {
      button.disabled = !hasSelection;
    } else {
      button.disabled = !canPaste;
    }
    button.addEventListener("click", () => {
      const actionRect = editorMenuRect;
      hideEditorMenu();
      void applyEditorMenuAction(action, actionRect);
    });
    editorMenu.appendChild(button);
  }
}

function applyDockAction(action, rect) {
  if (!rect) {
    return;
  }
  setActivePane(rect, { raise: true });

  if (action === "destroy") {
    destroyRectangle(rect, { closeServerTerminal: true });
    return;
  }

  if (action === "restore") {
    if (rect.restoreBox) {
      setRectangle(rect, rect.restoreBox);
    }
    clearFullState(rect);
    return;
  }

  const bounds = board.getBoundingClientRect();
  const usableHeight = Math.max(16, bounds.height - tabHeight);
  const halfWidth = Math.max(16, Math.floor(bounds.width / 2));
  const halfHeight = Math.max(16, Math.floor(usableHeight / 2));

  if (action !== "full") {
    clearFullState(rect);
  }

  if (action === "top") {
    setRectangle(rect, { x: 0, y: tabHeight, width: bounds.width, height: halfHeight });
  }
  if (action === "left") {
    setRectangle(rect, { x: 0, y: tabHeight, width: halfWidth, height: usableHeight });
  }
  if (action === "right") {
    setRectangle(rect, { x: bounds.width - halfWidth, y: tabHeight, width: halfWidth, height: usableHeight });
  }
  if (action === "bottom") {
    setRectangle(rect, { x: 0, y: bounds.height - halfHeight, width: bounds.width, height: halfHeight });
  }
  if (action === "full") {
    if (!rect.isFull) {
      rect.restoreBox = rectangleBox(rect);
    }
    rect.isFull = true;
    setRectangle(rect, { x: 0, y: tabHeight, width: bounds.width, height: usableHeight });
  }
}

async function applyEditorMenuAction(action, rect) {
  if (!rect?.editor) {
    return;
  }

  rect.editor.focus();

  if (action === "run") {
    await runPaneCommand(rect);
    return;
  }

  if (action === "copy") {
    const text = selectedEditorText(rect.editor);
    if (text) {
      await writeClipboardText(text);
    }
    rect.editor.focus();
    return;
  }

  if (action === "cut") {
    const text = selectedEditorText(rect.editor);
    if (text && await writeClipboardText(text)) {
      rect.editor.dispatch(rect.editor.state.replaceSelection(""));
    }
    rect.editor.focus();
    return;
  }

  if (action === "paste") {
    const text = await readClipboardText();
    if (text) {
      rect.editor.dispatch(rect.editor.state.replaceSelection(text));
    }
    rect.editor.focus();
  }
}

function commandTargetForEditor(editor) {
  if (!editor) {
    return null;
  }

  const state = editor.state;
  const range = state.selection.main;
  if (!range.empty) {
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    const command = state.doc.sliceString(from, to).replace(/\r\n/g, "\n").trimEnd();
    if (command.trim() === "") {
      return null;
    }
    const commandStart = firstNonWhitespacePosition(state.doc, from, to);
    const commandStartLine = state.doc.lineAt(commandStart);
    const lastSelectedPos = Math.max(from, to - 1);
    return {
      command,
      insertPos: state.doc.lineAt(lastSelectedPos).to,
      outputPrefix: commandStartLine.text.slice(0, commandStart - commandStartLine.from),
    };
  }

  const line = state.doc.lineAt(range.head);
  const command = line.text.trimEnd();
  if (command.trim() === "") {
    return null;
  }
  const commandStartColumn = line.text.search(/\S/);
  return {
    command,
    insertPos: line.to,
    outputPrefix: commandStartColumn > 0 ? line.text.slice(0, commandStartColumn) : "",
  };
}

function firstNonWhitespacePosition(doc, from, to) {
  for (let pos = from; pos < to; pos += 1) {
    if (/\S/.test(doc.sliceString(pos, pos + 1))) {
      return pos;
    }
  }
  return from;
}

async function runPaneCommand(rect) {
  if (!rect?.editor || rect.running) {
    return true;
  }

  const target = commandTargetForEditor(rect.editor);
  if (!target) {
    return true;
  }

  await flushWorkspaceSave();
  setActivePane(rect, { raise: true });
  markPaneRunning(rect, "");

  const editor = rect.editor;
  const spinner = createCommandTextSpinner(editor, target.insertPos);
  rect.commandSpinner = spinner;
  spinner.start();
  const transcript = createTranscriptInserter(editor, spinner.after(), target.outputPrefix);
  let streamStarted = false;
  let sawExit = false;

  try {
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspaceID,
        paneId: rect.id,
        command: target.command,
        cwd: rect.cwd || "",
        insertPos: target.insertPos,
        outputPrefix: target.outputPrefix,
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      transcript.appendHostMessage(`tessera: run failed ${response.status}${message ? ` ${message}` : ""}`);
      sawExit = true;
      return true;
    }

    streamStarted = true;
    await readRunEventStream(response, (event) => {
      applyRunEvent(rect, event);
      sawExit = sawExit || event.type === "exit";
    });
  } catch (error) {
    if (!streamStarted) {
      transcript.appendHostMessage(error.message || "run failed");
      sawExit = true;
    } else {
      console.warn(error);
    }
  } finally {
    try {
      spinner.stop();
    } finally {
      if (rect.commandSpinner === spinner) {
        rect.commandSpinner = null;
      }
    }
    rect.text = editor.state.doc.toString();
    if (sawExit || !streamStarted) {
      clearPaneRunning(rect);
      if (!streamStarted) {
        scheduleWorkspaceSave();
      }
    } else {
      void syncRunningCommands();
    }
  }

  return true;
}

function markPaneRunning(rect, runID) {
  rect.running = true;
  rect.runID = runID || rect.runID || "";
  rect.element.dataset.running = "true";
}

function clearPaneRunning(rect) {
  rect.running = false;
  rect.runID = "";
  delete rect.element.dataset.running;
}

function applyRunEvent(rect, event) {
  if (!rect?.editor || !event) {
    return;
  }
  if (event.runId) {
    markPaneRunning(rect, event.runId);
  }
  if (event.type === "snapshot") {
    replacePaneTextFromHost(rect, event.bufferText || "");
    if (event.cwd) {
      setPaneCwd(rect, event.cwd, { silent: true });
    }
    return;
  }
  if (event.type === "start" && event.cwd) {
    setPaneCwd(rect, event.cwd, { silent: true });
    return;
  }
  if (event.type === "insert") {
    insertPaneTextFromHost(rect, event.from || 0, event.text || "");
    return;
  }
  if (event.type === "error") {
    console.warn(event.error || "run error");
    return;
  }
  if (event.type === "exit") {
    if (event.cwd) {
      setPaneCwd(rect, event.cwd, { silent: true });
    }
    clearPaneRunning(rect);
  }
}

function replacePaneTextFromHost(rect, text) {
  const editor = rect.editor;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
    userEvent: "input.tesseraHostSnapshot",
  });
  rect.text = text;
}

function insertPaneTextFromHost(rect, from, text) {
  if (!text) {
    return;
  }
  const editor = rect.editor;
  const insertAt = rect.commandSpinner
    ? rect.commandSpinner.displayPosition(from)
    : from;
  const safeInsertAt = Math.max(0, Math.min(insertAt, editor.state.doc.length));
  const transaction = {
    changes: { from: safeInsertAt, insert: text },
    userEvent: "input.tesseraRunOutput",
  };
  if (editor.hasFocus) {
    transaction.selection = EditorSelection.cursor(safeInsertAt + text.length);
    transaction.scrollIntoView = true;
  }
  editor.dispatch(transaction);
  rect.text = rect.commandSpinner
    ? rect.commandSpinner.textWithoutSpinner(editor.state.doc.toString())
    : editor.state.doc.toString();
}

function createCommandTextSpinner(editor, position) {
  let currentPosition = position;
  let currentText = "";
  let frameIndex = 0;
  let timer = null;

  const dispatchSpinnerText = (nextText) => {
    const previousLength = currentText.length;
    const from = Math.min(currentPosition, editor.state.doc.length);
    const to = Math.min(from + previousLength, editor.state.doc.length);
    currentPosition = from;
    currentText = nextText;
    editor.dispatch({
      changes: { from, to, insert: nextText },
      userEvent: "input.tesseraSpinner",
    });
  };

  return {
    start() {
      dispatchSpinnerText(` ${commandSpinnerFrames[frameIndex]}`);
      timer = window.setInterval(() => {
        frameIndex = (frameIndex + 1) % commandSpinnerFrames.length;
        dispatchSpinnerText(` ${commandSpinnerFrames[frameIndex]}`);
      }, commandSpinnerIntervalMs);
    },
    after() {
      return currentPosition + currentText.length;
    },
    displayPosition(position) {
      if (currentText && position >= currentPosition) {
        return position + currentText.length;
      }
      return position;
    },
    map(changes) {
      currentPosition = changes.mapPos(currentPosition, -1);
    },
    stop() {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      if (currentText) {
        const previousLength = currentText.length;
        const from = Math.min(currentPosition, editor.state.doc.length);
        const to = Math.min(from + previousLength, editor.state.doc.length);
        currentPosition = from;
        currentText = "";
        editor.dispatch({
          changes: { from, to, insert: "" },
          userEvent: "input.tesseraSpinner",
        });
      }
    },
    textWithoutSpinner(text) {
      if (!currentText) {
        return text;
      }
      return text.slice(0, currentPosition) + text.slice(currentPosition + currentText.length);
    },
  };
}

function createTranscriptInserter(editor, insertPos, outputPrefix = "") {
  let cursor = insertPos;
  let commandOutputChars = 0;
  let lastInsertedChar = "\n";

  const insert = (text, commandOutputCharCount = 0) => {
    if (!text) {
      return;
    }
    text = text.replace(/\r\n?/g, "\n");
    cursor = Math.min(cursor, editor.state.doc.length);
    editor.dispatch({
      changes: { from: cursor, insert: text },
      selection: EditorSelection.cursor(cursor + text.length),
      scrollIntoView: true,
      userEvent: "input.tesseraRunOutput",
    });
    cursor += text.length;
    lastInsertedChar = text[text.length - 1];
    commandOutputChars += commandOutputCharCount;
  };

  const textAtOutputColumn = (text) => {
    if (!outputPrefix) {
      return text;
    }

    let prefixed = "";
    let atLineStart = lastInsertedChar === "\n";
    for (const char of text) {
      if (atLineStart && char !== "\n") {
        prefixed += outputPrefix;
        atLineStart = false;
      }
      prefixed += char;
      if (char === "\n") {
        atLineStart = true;
      }
    }
    return prefixed;
  };

  return {
    startOutputBelowCommand() {
      insert("\n");
    },
    appendCommandOutput(text) {
      insert(textAtOutputColumn(text), text.length);
    },
    appendHostMessage(message) {
      if (lastInsertedChar !== "\n") {
        insert("\n");
      }
      insert(textAtOutputColumn(`[${message}]\n`));
    },
    finish(exitCode) {
      if (commandOutputChars === 0 || exitCode !== 0) {
        if (lastInsertedChar !== "\n") {
          insert("\n");
        }
        insert(textAtOutputColumn(`[exit ${exitCode}]\n`));
      }
    },
  };
}

async function readRunEventStream(response, onEvent) {
  if (!response.body) {
    const text = await response.text();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        onEvent(JSON.parse(line));
      }
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  for (;;) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        onEvent(JSON.parse(line));
      }
    }

    if (done) {
      break;
    }
  }

  if (pending.trim()) {
    onEvent(JSON.parse(pending));
  }
}

function hasEditorSelection(editor) {
  return editor?.state.selection.ranges.some((range) => !range.empty) ?? false;
}

function selectedEditorText(editor) {
  return editor.state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => editor.state.doc.sliceString(range.from, range.to))
    .join("\n");
}

async function writeClipboardText(text) {
  editorClipboardText = text;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the synchronous copy fallback below.
    }
  }
  copyTextWithHiddenField(text);
  return true;
}

async function readClipboardText() {
  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      // Fall through to the synchronous paste fallback below.
    }
  }
  const pastedText = pasteTextWithHiddenField();
  return pastedText === null ? editorClipboardText : pastedText;
}

function copyTextWithHiddenField(text) {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-1000px";
  field.style.top = "0";
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  return copied;
}

function pasteTextWithHiddenField() {
  const field = document.createElement("textarea");
  field.style.position = "fixed";
  field.style.left = "-1000px";
  field.style.top = "0";
  document.body.appendChild(field);
  field.focus();
  let pasted = false;
  try {
    pasted = document.execCommand("paste");
  } catch {
    pasted = false;
  }
  const text = pasted ? field.value : null;
  field.remove();
  return text;
}

function destroyRectangle(rect, options = {}) {
  const index = rectangles.indexOf(rect);
  const wasActive = activePaneID === rect.id;
  if (index >= 0) {
    rectangles.splice(index, 1);
  }
  if (interaction?.rect === rect) {
    interaction = null;
  }
  if (contextMenuRect === rect) {
    contextMenuRect = null;
  }
  if (editorMenuRect === rect) {
    editorMenuRect = null;
  }
  if (windowTypeRect === rect) {
    windowTypeRect = null;
    windowTypeMenu.hidden = true;
  }
  if (wasActive) {
    activeRect = null;
    activePaneID = "";
    delete board.dataset.activePaneId;
  }
  disposeTerminal(rect, { closeServer: options.closeServerTerminal });
  rect.editor?.destroy();
  rect.editor = null;
  rect.element.remove();
  if (wasActive) {
    const nextActive = rectangles[Math.min(index, rectangles.length - 1)] || null;
    if (nextActive) {
      setActivePane(nextActive, { raise: true });
    }
  }
  scheduleWorkspaceSave();
}

function handlePaneKeyboardShortcuts(event) {
  if (event.defaultPrevented) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === "Enter") {
    event.preventDefault();
    runPaneCommand(getActivePane());
    return;
  }

  if (event.altKey && !event.ctrlKey && !event.metaKey && event.key === "`") {
    event.preventDefault();
    focusAdjacentPane(event.shiftKey ? -1 : 1);
    return;
  }

  if (!event.altKey && !event.ctrlKey && !event.metaKey && event.key === "F6") {
    event.preventDefault();
    focusAdjacentPane(event.shiftKey ? -1 : 1);
  }
}

function focusAdjacentPane(direction) {
  if (rectangles.length === 0) {
    return;
  }

  const current = getActivePane();
  const currentIndex = current ? rectangles.indexOf(current) : -1;
  const nextIndex = (currentIndex + direction + rectangles.length) % rectangles.length;
  setActivePane(rectangles[nextIndex], { raise: true, focusEditor: true });
}

function rectangleBox(rect) {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function clearFullState(rect) {
  rect.isFull = false;
  rect.restoreBox = null;
}

function hideMenusWhenOutside(event) {
  if (!dockMenu.hidden && !dockMenu.contains(event.target)) {
    hideDockMenu();
  }
  if (!editorMenu.hidden && !editorMenu.contains(event.target)) {
    hideEditorMenu();
  }
  if (!workspaceMenu.hidden && !workspaceMenu.contains(event.target)) {
    hideWorkspaceMenu();
  }
  if (!windowTypeMenu.hidden && !windowTypeMenu.contains(event.target)) {
    hideWindowTypeMenu();
  }
  if (!directoryBrowser.hidden && !directoryBrowser.contains(event.target)) {
    hideDirectoryBrowser();
  }
}

function hideMenusOnEscape(event) {
  if (event.key === "Escape") {
    hideAllMenus();
  }
}

function hideAllMenus() {
  hideDockMenu();
  hideEditorMenu();
  hideWorkspaceMenu();
  hideWindowTypeMenu();
  hideDirectoryBrowser();
}

function hideDockMenu() {
  dockMenu.hidden = true;
  contextMenuRect = null;
}

function hideEditorMenu() {
  editorMenu.hidden = true;
  editorMenuRect = null;
}

function hideWorkspaceMenu() {
  workspaceMenu.hidden = true;
  workspaceMenuPoint = null;
}

function hideWindowTypeMenu(options = {}) {
  const rect = windowTypeRect;
  windowTypeMenu.hidden = true;
  windowTypeRect = null;
  if (options.finalizeDefault === false) {
    return;
  }
  if (rect && rect.kind === "pending" && rectangles.includes(rect)) {
    finalizePendingRectangle(rect, "worksheet");
  }
}

function hideDirectoryBrowser() {
  directoryBrowser.hidden = true;
  directoryBrowserRect = null;
  directoryBrowserPath = "";
}

function showMenuAt(menu, clientX, clientY) {
  menu.hidden = false;
  const menuBox = menu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - menuBox.width - 6);
  const top = Math.min(clientY, window.innerHeight - menuBox.height - 6);
  menu.style.left = `${Math.max(6, left)}px`;
  menu.style.top = `${Math.max(6, top)}px`;
}

function boxFromDrag(startX, startY, pointerX, pointerY, square) {
  let dx = pointerX - startX;
  let dy = pointerY - startY;
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = dx < 0 ? -side : side;
    dy = dy < 0 ? -side : side;
  }

  const x = Math.min(startX, startX + dx);
  const y = Math.min(startY, startY + dy);
  return {
    x,
    y,
    width: Math.abs(dx),
    height: Math.abs(dy),
  };
}

function resizeBox(original, handle, dx, dy, square) {
  let left = original.x;
  let top = original.y;
  let right = original.x + original.width;
  let bottom = original.y + original.height;

  if (handle.includes("w")) {
    left += dx;
  }
  if (handle.includes("e")) {
    right += dx;
  }
  if (handle.includes("n")) {
    top += dy;
  }
  if (handle.includes("s")) {
    bottom += dy;
  }

  if (right - left < 16) {
    handle.includes("w") ? (left = right - 16) : (right = left + 16);
  }
  if (bottom - top < 16) {
    handle.includes("n") ? (top = bottom - 16) : (bottom = top + 16);
  }

  if (square) {
    const side = Math.max(right - left, bottom - top);
    if (handle.includes("w")) {
      left = right - side;
    } else {
      right = left + side;
    }
    if (handle.includes("n")) {
      top = bottom - side;
    } else {
      bottom = top + side;
    }
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function clampIntoBoard(rect) {
  const bounds = board.getBoundingClientRect();
  rect.width = Math.min(rect.width, bounds.width);
  rect.height = Math.min(rect.height, bounds.height - tabHeight);
  rect.x = Math.min(Math.max(0, rect.x), bounds.width - rect.width);
  rect.y = Math.min(Math.max(tabHeight, rect.y), bounds.height - rect.height);
}

function boardPoint(event) {
  const bounds = board.getBoundingClientRect();
  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
  };
}
