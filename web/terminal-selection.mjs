// ghostty-web 0.4.0 assumes an always-running renderer and a bubbling mouseup.
// Adapt its private selection manager alongside Tessera's scheduled renderer.
export function installTerminalSelection(terminal) {
  const manager = terminal.selectionManager;
  const canvas = terminal.renderer?.getCanvas();
  const container = terminal.element;
  const doc = canvas?.ownerDocument;
  if (!manager || !canvas || !container || !doc) return null;

  const view = doc.defaultView;
  const originalRequestRender = manager.requestRender;
  const originalClearSelection = manager.clearSelection;
  const originalPixelToCell = manager.pixelToCell;
  const originalNormalizeSelection = manager.normalizeSelection;
  const listeners = [];
  let pointerID = null;
  let directPointerID = null;
  let restoreInput = null;

  // iOS can focus the contenteditable terminal as a touch default action even
  // when pointer/mouse handlers are cancelled. Selection is not an input mode:
  // make both upstream input surfaces non-editable until Done, not just blurred.
  const setInputSuppressed = on => {
    if (on === Boolean(restoreInput)) return;
    if (!on) {
      const restore = restoreInput;
      restoreInput = null;
      restore?.();
      return;
    }
    const attributes = [[container, "contenteditable", "false"], [container, "inputmode", "none"]];
    const textarea = terminal.textarea || manager.textarea;
    if (textarea) attributes.push([textarea, "readonly", ""], [textarea, "inputmode", "none"]);
    const previous = attributes.map(([node, name]) => [node, name, node.getAttribute(name)]);
    restoreInput = () => {
      for (const [node, name, value] of previous) {
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      }
    };
    for (const [node, name, value] of attributes) node.setAttribute(name, value);
    if (container.contains(doc.activeElement)) doc.activeElement?.blur?.();
  };

  const pointerCell = event => {
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height || !originalPixelToCell) return null;
    const x = Math.max(0, Math.min(box.width - 1, event.clientX - box.left));
    const y = Math.max(0, Math.min(box.height - 1, event.clientY - box.top));
    const cell = manager.pixelToCell(x, y);
    return { col: cell.col, absoluteRow: manager.viewportRowToAbsolute(cell.row) };
  };

  const beginPointerSelection = event => {
    const cell = pointerCell(event);
    if (!cell) return false;
    terminal.smoothScroll?.cancel();
    manager.clearSelection();
    directPointerID = event.pointerId;
    manager.selectionStart = cell;
    manager.selectionEnd = { ...cell };
    manager.isSelecting = true;
    terminal.requestRender();
    return true;
  };

  const movePointerSelection = event => {
    if (directPointerID === null || directPointerID !== event.pointerId) return false;
    const cell = pointerCell(event);
    if (!cell) return false;
    manager.markCurrentSelectionDirty?.();
    manager.selectionEnd = cell;
    // Alternate-screen scrolling belongs to the TUI, never local autoscroll.
    if (!terminal.wasmTerm?.isAlternateScreen?.()) {
      const box = canvas.getBoundingClientRect();
      manager.updateAutoScroll?.(event.clientY - box.top, box.height);
    }
    terminal.requestRender();
    return true;
  };

  const endPointerSelection = event => {
    if (directPointerID === null || (event?.pointerId != null && event.pointerId !== directPointerID)) return false;
    directPointerID = null;
    manager.isSelecting = false;
    manager.stopAutoScroll();
    manager.selectionChangedEmitter?.fire();
    terminal.requestRender();
    return true;
  };

  const clearNativeSelection = () => {
    const selection = doc.getSelection?.();
    if (!selection || selection.isCollapsed) return;
    for (let index = selection.rangeCount - 1; index >= 0; index--) {
      const range = selection.getRangeAt(index);
      // Safari can select the editable canvas as one object. Limit cleanup to
      // that terminal; hidden textareas and editor selections must survive.
      if (container.contains(range.startContainer) && container.contains(range.endContainer)
          && range.intersectsNode(canvas)) {
        selection.removeRange(range);
      }
    }
  };

  manager.requestRender = () => terminal.requestRender();
  if (originalPixelToCell) manager.pixelToCell = (x, y) => {
    const fraction = terminal.viewportY - Math.floor(terminal.viewportY);
    if (!fraction) return originalPixelToCell.call(manager, x, y);
    const height = terminal.renderer.getMetrics().height;
    const ratio = terminal.renderer.devicePixelRatio || 1;
    const offset = Math.round(fraction * height * ratio) / ratio;
    const cell = originalPixelToCell.call(manager, x, y - offset);
    // The partial history row above row zero is visible during pixel scrolling.
    if (y < offset) cell.row = -1;
    return cell;
  };
  if (originalNormalizeSelection) manager.normalizeSelection = () => {
    if (Number.isInteger(terminal.viewportY)) return originalNormalizeSelection.call(manager);
    if (!manager.selectionStart || !manager.selectionEnd) return null;
    let start = manager.selectionStart, end = manager.selectionEnd;
    if (start.absoluteRow > end.absoluteRow
        || (start.absoluteRow === end.absoluteRow && start.col > end.col)) [start, end] = [end, start];
    const startRow = manager.absoluteRowToViewport(start.absoluteRow);
    const endRow = manager.absoluteRowToViewport(end.absoluteRow);
    if (endRow < -1 || startRow >= terminal.rows) return null;
    return {
      startRow: Math.max(-1, startRow), startCol: startRow < -1 ? 0 : start.col,
      endRow: Math.min(terminal.rows - 1, endRow), endCol: endRow >= terminal.rows ? terminal.cols - 1 : end.col,
    };
  };
  manager.clearSelection = () => {
    directPointerID = null;
    manager.stopAutoScroll();
    manager.isSelecting = false;
    originalClearSelection.call(manager);
    // Upstream returns early when both endpoints coincide, leaving a drag
    // latched even though hasSelection() is false.
    manager.selectionStart = null;
    manager.selectionEnd = null;
    clearNativeSelection();
    terminal.requestRender();
  };

  const finishDrag = (event, copy = false) => {
    // Touch selection has an explicit Copy control. Do not auto-copy (or focus
    // an invisible editable field) from upstream's document-level mouseup.
    if (directPointerID !== null) { endPointerSelection(event); return; }
    if (event?.pointerId != null && pointerID !== null && event.pointerId !== pointerID) return;
    pointerID = null;
    if (!manager.isSelecting) return;
    if (copy && manager.hasSelection()) {
      // Run the normal upstream release once, including its selection copy,
      // before capture/bubbling differences can hide the compatibility event.
      manager.boundMouseUpHandler(event);
    } else {
      manager.isSelecting = false;
      manager.stopAutoScroll();
      if (!manager.hasSelection()) manager.clearSelection();
    }
    terminal.requestRender();
  };

  const listen = (target, type, handler) => {
    if (!target) return;
    target.addEventListener(type, handler, { capture: true });
    listeners.push(() => target.removeEventListener(type, handler, { capture: true }));
  };
  listen(canvas, "pointerdown", (event) => {
    terminal.smoothScroll?.cancel();
    if (event.button === 0) pointerID = event.pointerId;
  });
  listen(canvas, "mousedown", () => {
    terminal.smoothScroll?.cancel();
    clearNativeSelection();
  });
  listen(container, "selectstart", (event) => {
    if (event.target === canvas) event.preventDefault();
  });
  listen(container, "focusin", event => {
    if (restoreInput) {
      event.stopImmediatePropagation();
      event.target?.blur?.();
    }
  });
  listen(doc, "selectionchange", clearNativeSelection);
  listen(doc, "pointerup", (event) => {
    if (event.button === 0) finishDrag(event, true);
  });
  listen(doc, "mouseup", (event) => {
    if (event.button === 0) finishDrag(event, true);
  });
  listen(doc, "mousemove", (event) => {
    if (directPointerID !== null) {
      // Pointer capture owns the endpoints, even outside the canvas. Upstream
      // document mousemove must not mutate them or start TUI autoscroll.
      if (typeof event.buttons === "number" && !(event.buttons & 1)) finishDrag(event);
      event.stopImmediatePropagation();
      return;
    }
    if (typeof event.buttons === "number" && !(event.buttons & 1)) finishDrag(event);
  });
  listen(doc, "pointercancel", (event) => finishDrag(event));
  listen(doc, "lostpointercapture", (event) => finishDrag(event));
  listen(container, "contextmenu", (event) => {
    finishDrag();
    clearNativeSelection();
  });
  listen(view, "blur", () => finishDrag());
  listen(doc, "visibilitychange", () => {
    if (doc.hidden) finishDrag();
  });
  clearNativeSelection();

  return {
    clearNativeSelection,
    setInputSuppressed,
    beginPointerSelection,
    movePointerSelection,
    endPointerSelection,
    cancelDrag: () => finishDrag(),
    dispose() {
      finishDrag();
      setInputSuppressed(false);
      for (const remove of listeners) remove();
      manager.requestRender = originalRequestRender;
      manager.clearSelection = originalClearSelection;
      if (originalPixelToCell) manager.pixelToCell = originalPixelToCell;
      if (originalNormalizeSelection) manager.normalizeSelection = originalNormalizeSelection;
    },
  };
}
