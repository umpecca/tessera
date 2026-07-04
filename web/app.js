import { basicSetup, EditorSelection, EditorView, Prec, keymap } from "./vendor/codemirror.js";

const board = document.querySelector("#board");
const tabHeight = 24;
const rectangles = [];
let activeRect = null;
let activePaneID = "";
let interaction = null;
let nextZIndex = 1;
let contextMenuRect = null;
let editorMenuRect = null;
let directoryBrowserRect = null;
let directoryBrowserPath = "";
let editorClipboardText = "";
let workspaceID = "default";
let isLoadingWorkspace = false;
let saveTimer = null;
let saveRevision = 0;

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

const directoryBrowser = document.createElement("div");
directoryBrowser.className = "directory-browser";
directoryBrowser.hidden = true;
document.body.appendChild(directoryBrowser);

board.addEventListener("pointerdown", startDrawing);
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

  const point = boardPoint(event);
  const rect = createRectangle(point.x, point.y, 1, 1);
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

  if (interaction.type === "draw" && (interaction.rect.width < 6 || interaction.rect.height < 6)) {
    destroyRectangle(interaction.rect);
  }

  interaction = null;
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
    x,
    y,
    width,
    height,
    element,
    zIndex: options.zIndex || 0,
    title: options.title || "",
    text: options.text || "",
    cwd: options.cwd || "",
    running: false,
    isFull: false,
    restoreBox: null,
  };
  element.dataset.paneId = rect.id;
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
  body.setAttribute("aria-label", "Workspace text");
  body.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    setActivePane(rect, { raise: true });
  });
  body.addEventListener("focusin", () => setActivePane(rect, { raise: true }));
  body.addEventListener("contextmenu", (event) => openEditorMenu(event, rect));

  tab.appendChild(grip);
  tab.appendChild(title);
  status.appendChild(cwdLabel);
  status.appendChild(cwdInput);
  element.appendChild(tab);
  element.appendChild(body);
  element.appendChild(status);
  rect.cwdInput = cwdInput;
  setPaneCwd(rect, rect.cwd, { silent: true });

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
          rect.text = update.state.doc.toString();
          scheduleWorkspaceSave();
        }
      }),
    ],
    parent: body,
  });

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
    rect.editor?.focus();
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
  scheduleWorkspaceSave();
}

async function loadWorkspace() {
  isLoadingWorkspace = true;
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
  } catch (error) {
    console.warn(error);
  } finally {
    isLoadingWorkspace = false;
  }
}

function clearRectanglesForLoad() {
  for (const rect of rectangles.splice(0)) {
    rect.editor?.destroy();
    rect.element.remove();
  }
  activeRect = null;
  activePaneID = "";
  delete board.dataset.activePaneId;
  interaction = null;
  contextMenuRect = null;
  editorMenuRect = null;
  nextZIndex = 1;
  hideAllMenus();
}

function scheduleWorkspaceSave() {
  if (isLoadingWorkspace) {
    return;
  }
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
  const panes = rectangles.map((rect, index) => ({
    id: rect.id,
    title: rect.title,
    bufferText: rect.text,
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
        activePaneId: activePaneID,
        layout: { panes: panes.map((pane) => pane.id) },
        panes,
      }),
    });
    if (!response.ok) {
      throw new Error(`save workspace failed: ${response.status}`);
    }
  } catch (error) {
    if (revision === saveRevision) {
      console.warn(error);
    }
  }
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
  setActivePane(rect, { raise: true });
  hideEditorMenu();
  contextMenuRect = rect;
  renderDockMenu(rect);
  showMenuAt(dockMenu, event.clientX, event.clientY);
}

function openEditorMenu(event, rect) {
  event.preventDefault();
  event.stopPropagation();
  setActivePane(rect, { raise: true });
  hideDockMenu();
  editorMenuRect = rect;
  renderEditorMenu(rect);
  showMenuAt(editorMenu, event.clientX, event.clientY);
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
    button.addEventListener("click", async () => {
      await applyEditorMenuAction(action, editorMenuRect);
      hideEditorMenu();
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
    destroyRectangle(rect);
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
    rect.editor.focus();
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
    const lastSelectedPos = Math.max(from, to - 1);
    return {
      command,
      insertPos: state.doc.lineAt(lastSelectedPos).to,
    };
  }

  const line = state.doc.lineAt(range.head);
  const command = line.text.trimEnd();
  if (command.trim() === "") {
    return null;
  }
  return {
    command,
    insertPos: line.to,
  };
}

async function runPaneCommand(rect) {
  if (!rect?.editor || rect.running) {
    return true;
  }

  const target = commandTargetForEditor(rect.editor);
  if (!target) {
    return true;
  }

  setActivePane(rect, { raise: true });
  rect.running = true;
  rect.element.dataset.running = "true";

  const editor = rect.editor;
  const transcript = createTranscriptInserter(editor, target.insertPos);
  transcript.startOutputBelowCommand();

  try {
    await flushWorkspaceSave();
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspaceID,
        paneId: rect.id,
        command: target.command,
        cwd: rect.cwd || "",
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      transcript.appendHostMessage(`tessera: run failed ${response.status}${message ? ` ${message}` : ""}`);
      return true;
    }

    await readRunEventStream(response, (event) => {
      if (event.type === "start" && event.cwd) {
        setPaneCwd(rect, event.cwd);
      }
      if (event.type === "stdout" || event.type === "stderr") {
        transcript.appendCommandOutput(event.text || "");
      }
      if (event.type === "error") {
        transcript.appendHostMessage(event.error || "run error");
      }
      if (event.type === "exit") {
        if (event.cwd) {
          setPaneCwd(rect, event.cwd);
        }
        const exitCode = typeof event.code === "number" ? event.code : 0;
        transcript.finish(exitCode);
      }
    });
  } catch (error) {
    transcript.appendHostMessage(error.message || "run failed");
  } finally {
    rect.running = false;
    delete rect.element.dataset.running;
    rect.text = editor.state.doc.toString();
    scheduleWorkspaceSave();
    editor.focus();
  }

  return true;
}

function createTranscriptInserter(editor, insertPos) {
  let cursor = insertPos;
  let commandOutputChars = 0;
  let lastInsertedChar = "\n";

  const insert = (text, countsAsCommandOutput) => {
    if (!text) {
      return;
    }
    editor.dispatch({
      changes: { from: cursor, insert: text },
      selection: EditorSelection.cursor(cursor + text.length),
      scrollIntoView: true,
      userEvent: "input.tesseraRunOutput",
    });
    cursor += text.length;
    lastInsertedChar = text[text.length - 1];
    if (countsAsCommandOutput) {
      commandOutputChars += text.length;
    }
  };

  return {
    startOutputBelowCommand() {
      insert("\n", false);
    },
    appendCommandOutput(text) {
      insert(text, true);
    },
    appendHostMessage(message) {
      const prefix = lastInsertedChar === "\n" ? "" : "\n";
      insert(`${prefix}[${message}]\n`, false);
    },
    finish(exitCode) {
      if (commandOutputChars === 0 || exitCode !== 0) {
        const prefix = lastInsertedChar === "\n" ? "" : "\n";
        insert(`${prefix}[exit ${exitCode}]\n`, false);
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

function destroyRectangle(rect) {
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
  if (wasActive) {
    activeRect = null;
    activePaneID = "";
    delete board.dataset.activePaneId;
  }
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
