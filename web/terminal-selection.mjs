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
  const listeners = [];
  let pointerID = null;

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
  manager.clearSelection = () => {
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
    if (event.button === 0) pointerID = event.pointerId;
  });
  listen(canvas, "mousedown", clearNativeSelection);
  listen(container, "selectstart", (event) => {
    if (event.target === canvas) event.preventDefault();
  });
  listen(doc, "selectionchange", clearNativeSelection);
  listen(doc, "pointerup", (event) => {
    if (event.button === 0) finishDrag(event, true);
  });
  listen(doc, "mouseup", (event) => {
    if (event.button === 0) finishDrag(event, true);
  });
  listen(doc, "mousemove", (event) => {
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
    dispose() {
      finishDrag();
      for (const remove of listeners) remove();
      manager.requestRender = originalRequestRender;
      manager.clearSelection = originalClearSelection;
    },
  };
}
