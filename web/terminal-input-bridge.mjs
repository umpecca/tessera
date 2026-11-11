import { TerminalTouchScroll } from "./terminal-touch-scroll.mjs";
import { shouldIsolateMacTerminalPasteKeydown } from "./terminal-keyboard.mjs";
import { TerminalContextMenuFallback, TerminalMouseHover, TerminalMousePress, clearTerminalSelectionStartedDuringGesture, isTerminalContextMenuGesture, terminalHoverButtonCode, terminalMouseMessage, terminalPasteText } from "./terminal-input.mjs";
import { pastedImage, terminalPasteKeys, writeHostClipboardImage } from "./clipboard-image.mjs";
import { wheelDeltaUnits } from "./wheel-sensitivity.mjs";

// A modest boost for phone-layout finger scrolling; desktop/tablet gestures,
// wheel devices, page buttons and selection coordinates stay unchanged.
const phoneTouchScrollMultiplier = 1.35;

// DOM keyboard, paste, selection and mouse bridges for terminals.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   clipboard: () => ReturnType<typeof import("./clipboard-access.mjs").createClipboard>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   interactions: () => ReturnType<typeof import("./desktop-interactions.mjs").createInteractions>,
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 *   phone: () => ReturnType<typeof import("./phone-workspace.mjs").createPhone>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   terminal: () => ReturnType<typeof import("./terminal-view.mjs").createTerminal>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createTerminalInput(dependencies, platform = globalThis) {
  const feature = {};

  // ghostty-web's own paste listener passes the clipboard text to the PTY the
  // same way it passes typing, so an application never learns that a paste
  // happened: no bracketed paste, and a TUI editor records the text as a run of
  // single keystrokes, which its undo then walks back one character at a time.
  // This listener sits on the pane body, so the capture phase reaches it before
  // the container listener ghostty-web installed, and pastes through the terminal
  // instead — which wraps the text whenever the application asked for bracketed
  // paste.
  // An image goes to the host clipboard, then the program gets its paste key
  // and reads it from there; see clipboard-image.mjs.
  async function pasteImageIntoTerminal(rect, term, image) {
    dependencies.workspace().setWorkspaceStatus("saving", "Pasting image…");
    try {
      dependencies.clipboard().hostClipboardStatus = await writeHostClipboardImage(image);
      dependencies.clipboard().hostClipboardStatusFailed = false;
    } catch (error) {
      if (error.status?.session) dependencies.clipboard().hostClipboardStatus = error.status;
      dependencies.workspace().setWorkspaceStatus("error", "Image paste failed", error.message);
      return;
    }
    for (const keys of terminalPasteKeys(term, { appleKeyboard: dependencies.interactions().appleKeyboardLayout })) {
      dependencies.terminal().sendTerminalKeys(rect, keys);
    }
    dependencies.workspace().setWorkspaceStatus("saved", "Image pasted");
  }

  function attachTerminalPasteBridge(rect, term) {
    const host = rect.terminalContainer?.parentElement;
    if (!host) {
      return null;
    }

    const onKeyDown = (event) => {
      if (!rect.terminalContainer?.contains(event.target)) {
        return;
      }
      if (!shouldIsolateMacTerminalPasteKeydown(event, { appleKeyboard: dependencies.interactions().appleKeyboardLayout })) {
        return;
      }
      // Do not preventDefault(): Chrome's default action is what emits the
      // trusted paste event below. Only keep the physical `v` keydown away from
      // ghostty-web and the raw-mode application behind it.
      event.stopImmediatePropagation();
    };

    const onPaste = (event) => {
      if (!rect.terminalContainer?.contains(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const text = terminalPasteText(event.clipboardData?.getData("text/plain") || "");
      if (text) {
        term.paste(text);
        return;
      }
      const image = pastedImage(event.clipboardData);
      if (image) {
        void feature.pasteImageIntoTerminal(rect, term, image);
      }
    };

    host.addEventListener("keydown", onKeyDown, { capture: true });
    host.addEventListener("paste", onPaste, { capture: true });

    return {
      dispose() {
        host.removeEventListener("keydown", onKeyDown, { capture: true });
        host.removeEventListener("paste", onPaste, { capture: true });
      },
    };
  }

  // In the phone view, whether the Type button has this terminal typing
  // straight into it.
  function phoneTypingInto(rect) {
    const view = dependencies.phone().phoneView;
    return view.active && view.openPaneID === rect.id && !view.selecting && view.mode !== "scroll" && Boolean(view.input?.direct);
  }

  function attachTerminalMouseBridge(rect, term, socket) {
    const container = rect.terminalContainer;
    if (!container) {
      return null;
    }

    const activePress = new TerminalMousePress();
    const hover = new TerminalMouseHover();
    const contextMenuFallback = new TerminalContextMenuFallback();
    let selectionAtReportedPress = null;
    let controlPress = false;
    let wheelRemainder = 0;
    let wheelDirection = 0;
    const touchScroll = new TerminalTouchScroll();
    let touchRemainder = 0;
    let selectionAtTouch = null;
    let scrollModeGesture = false;
    let mouseScrollGesture = false;
    const cancelledTouches = new Set();
    const captures = new Map();
    const phoneView = dependencies.phone().phoneView;
    const readingSurface = phoneView?.readingView;
    const phoneScrollMode = () => phoneView?.active && phoneView.openPaneID === rect.id && phoneView.mode === "scroll";
    const phoneSelecting = () => phoneView?.active && phoneView.openPaneID === rect.id && phoneView.selecting;
    let localSelectionID = null;
    const releaseCapture = (id) => {
      const target = captures.get(id);
      captures.delete(id);
      if (target?.hasPointerCapture?.(id)) target.releasePointerCapture(id);
    };

    const scaledDiscreteWheelSteps = (baseSteps, direction) => {
      if (direction !== wheelDirection) {
        wheelRemainder = 0;
        wheelDirection = direction;
      }
      const scaled = baseSteps * dependencies.preferences().terminalWheelSensitivity + wheelRemainder;
      const steps = Math.min(20, Math.floor(scaled));
      wheelRemainder = scaled - Math.floor(scaled);
      return steps;
    };

    // macOS turns Control-click into a secondary click. As in native Mac
    // terminals, a mouse-aware program hears it as a right click that keeps Ctrl.
    const reportsMacControl = (event) => dependencies.interactions().appleKeyboardLayout && event.ctrlKey
      && feature.terminalShouldReportMouse(term, event, { allowControl: true });

    // The second finger turns the first one's press into a scroll: the
    // program hears it released where it was, and a selection it began goes.
    const beginTouchScroll = (event) => {
      if (localSelectionID !== null) {
        term.selectionIntegration?.endPointerSelection?.();
        localSelectionID = null;
        term.clearSelection?.();
      }
      feature.stopTerminalMouseEvent(event);
      touchRemainder = 0;
      const release = activePress.finish(null);
      if (release) {
        feature.sendTerminalMouseSequence(socket, feature.terminalMouseEventCode(release.buttonCode, event), release.position, "m");
        if (container.hasPointerCapture?.(release.pointerID)) {
          container.releasePointerCapture(release.pointerID);
        }
      }
      clearTerminalSelectionStartedDuringGesture(term, selectionAtTouch);
      selectionAtTouch = null;
    };

    // Two fingers carry the content with them: the scrollback a line per line
    // of travel, and a full-screen program a wheel step or arrow key per line.
    const scrollByTouch = (deltaY, event) => {
      if (phoneView?.active && phoneView.openPaneID === rect.id) deltaY *= phoneTouchScrollMultiplier;
      const lineHeight = term.renderer?.getMetrics?.().height || 20;
      const reporting = feature.terminalShouldReportMouse(term, event);
      if (scrollModeGesture && !phoneSelecting() && !mouseScrollGesture) {
        touchRemainder = 0;
        if (event.currentTarget === readingSurface && readingSurface) readingSurface.scrollTop += deltaY;
        else term.scrollWheelLines(deltaY / lineHeight);
        return;
      }
      // In Scroll mode two fingers mean mouse wheel only, not arrow keys that
      // could select a command in a shell or answer a program unexpectedly.
      if ((scrollModeGesture || (phoneSelecting() && term.wasmTerm?.isAlternateScreen?.())) && !reporting) {
        touchRemainder = 0;
        return;
      }
      if (!reporting && !term.wasmTerm?.isAlternateScreen?.()) {
        touchRemainder = 0;
        term.scrollWheelLines(deltaY / lineHeight);
        return;
      }
      touchRemainder += deltaY / lineHeight;
      const steps = Math.trunc(touchRemainder);
      if (steps === 0) {
        return;
      }
      touchRemainder -= steps;
      const position = reporting ? feature.terminalMousePosition(term, container, event) : null;
      if (reporting && !position) {
        return;
      }
      for (let index = 0; index < Math.abs(steps); index += 1) {
        if (reporting) {
          feature.sendTerminalMouseSequence(socket, feature.terminalMouseEventCode(steps < 0 ? 64 : 65, event), position, "M");
        } else {
          term.input(steps < 0 ? "\x1B[A" : "\x1B[B", true);
        }
      }
    };

    // ghostty-web focuses its input textarea whenever a touch ends on the
    // canvas, which opens a phone's keyboard. Fingers lifting from a two-finger
    // scroll aren't a tap, so their touchend stops here, and in the phone view
    // every touchend does: the keyboard opens from the Type button. With Type
    // on, a tap gives the terminal itself the keyboard back; ghostty-web's
    // textarea is out of sight, and iOS offers no way to dismiss a keyboard it
    // opened. Pointer events come first, so the scroll has ended by the last
    // touchend: count touches here.
    let multiTouch = false;
    const onTouchStart = (event) => {
      if (phoneView?.active && !feature.phoneTypingInto(rect)) event.preventDefault();
      if (event.touches.length > 1) multiTouch = true;
    };
    const onTouchEnd = (event) => {
      const scrolled = multiTouch;
      if (event.touches.length === 0) multiTouch = false;
      if (!scrolled && !dependencies.phone().phoneView.active) return;
      event.preventDefault();
      event.stopPropagation();
      if (!scrolled && event.touches.length === 0 && feature.phoneTypingInto(rect) && platform.document.activeElement !== container) term.focus();
    };

    const onPointerDown = (event) => {
      // A new primary touch proves the previous touch sequence has ended.
      // Safari can omit its final release after keyboard/OS UI or capture
      // changes; neither phantom fingers nor cancelled IDs may block this one.
      if (event.pointerType === "touch" && event.isPrimary === true) {
        if (touchScroll.touches.size || cancelledTouches.size) {
          cancelTouchGesture();
          cancelledTouches.clear();
        }
        multiTouch = false;
      }
      if (event.pointerType !== "touch" && !phoneScrollMode()) scrollModeGesture = false;
      if (event.pointerType === "touch" && !touchScroll.touches.size) {
        scrollModeGesture = Boolean(phoneScrollMode() && !phoneSelecting());
        mouseScrollGesture = false;
      }
      if (cancelledTouches.size) {
        if (event.pointerType === "touch") cancelledTouches.add(event.pointerId);
        feature.stopTerminalMouseEvent(event);
        return;
      }
      if (touchScroll.down(event, scrollModeGesture ? 1 : 2)) {
        if (touchScroll.touches.size >= 2) mouseScrollGesture = true;
        beginTouchScroll(event);
        if (event.currentTarget?.setPointerCapture) {
          event.currentTarget.setPointerCapture(event.pointerId);
          captures.set(event.pointerId, event.currentTarget);
        }
        return;
      }
      if (phoneScrollMode() && !phoneSelecting()) {
        feature.stopTerminalMouseEvent(event);
        return;
      }
      if (phoneSelecting()) {
        feature.stopTerminalMouseEvent(event);
        if (event.button !== 0 || !term.selectionIntegration?.beginPointerSelection?.(event)) return;
        localSelectionID = event.pointerId;
        container.setPointerCapture?.(event.pointerId);
        captures.set(event.pointerId, container);
        return;
      }
      if (event.pointerType === "touch") {
        try {
          selectionAtTouch = Boolean(term.hasSelection?.());
        } catch {
          selectionAtTouch = null;
        }
      }
      selectionAtReportedPress = null;
      controlPress = dependencies.interactions().appleKeyboardLayout && event.button === 0 && event.ctrlKey;
      const reportControl = reportsMacControl(event);
      if (!reportControl && isTerminalContextMenuGesture(event, { appleKeyboard: dependencies.interactions().appleKeyboardLayout })
          && !feature.terminalShouldReportMouse(term, event)) {
        // ghostty-web's selection manager handles every mouse-down. Cancel the
        // compatibility mouse event so a secondary click cannot replace the
        // selection that Tessera's context-menu Copy action is about to read.
        feature.stopTerminalMouseEvent(event);
        return;
      }
      const buttonCode = controlPress ? 2 : feature.terminalMouseButtonCode(event.button);
      if (buttonCode == null || !(reportControl || feature.terminalShouldReportMouse(term, event))) {
        if (phoneView?.active && !feature.phoneTypingInto(rect)) feature.stopTerminalMouseEvent(event);
        return;
      }
      const position = feature.terminalMousePosition(term, container, event);
      if (!position) {
        return;
      }
      try {
        selectionAtReportedPress = Boolean(term.hasSelection?.());
      } catch {
        selectionAtReportedPress = null;
      }
      contextMenuFallback.notePress(buttonCode, event.timeStamp);
      feature.stopTerminalMouseEvent(event);
      dependencies.menus().hideFloatingMenus();
      dependencies.desktop().setActivePane(rect, { raise: true });
      if (!phoneView?.active || feature.phoneTypingInto(rect)) term.focus();
      activePress.begin(event.pointerId, buttonCode, position);
      container.setPointerCapture?.(event.pointerId);
      feature.sendTerminalMouseSequence(socket, feature.terminalMouseEventCode(buttonCode, event), position, "M");
    };

    const onMouseDown = (event) => {
      if (phoneView?.active && !feature.phoneTypingInto(rect)) { feature.stopTerminalMouseEvent(event); return; }
      if (phoneSelecting()) { feature.stopTerminalMouseEvent(event); return; }
      if (phoneScrollMode() || cancelledTouches.size || (scrollModeGesture && touchScroll.scrolling)) {
        feature.stopTerminalMouseEvent(event);
        return;
      }
      // Safari may send a Control-primary mousedown without a PointerEvent.
      // Keep macOS's contextual click out of Ghostty's left-drag selection.
      if (dependencies.interactions().appleKeyboardLayout && event.button === 0 && event.ctrlKey) controlPress = true;
      if (isTerminalContextMenuGesture(event, { appleKeyboard: dependencies.interactions().appleKeyboardLayout })
          && !feature.terminalShouldReportMouse(term, event)) {
        feature.stopTerminalMouseEvent(event);
        return;
      }
      if (selectionAtReportedPress !== null || !feature.terminalShouldReportMouse(term, event)) {
        return;
      }
      // WebKit can deliver a compatibility mousedown even when it omits the
      // corresponding PointerEvent. Capture the pre-gesture selection state
      // before ghostty-web's canvas listener can start a local selection.
      try {
        selectionAtReportedPress = Boolean(term.hasSelection?.());
      } catch {
        selectionAtReportedPress = null;
      }
    };

    // Compatibility mouse events must not run upstream's focus-taking,
    // auto-copying selection handlers after our pointer-based selection.
    const onSelectionMouseEvent = event => {
      if (phoneSelecting()) feature.stopTerminalMouseEvent(event);
    };

    const finishTerminalPointer = (event, pointerID = event.pointerId) => {
      const position = event.type === "pointercancel" || event.type === "lostpointercapture"
        ? null
        : feature.terminalMousePosition(term, container, event);
      const release = activePress.finish(pointerID, position);
      if (!release) {
        return false;
      }
      feature.stopTerminalMouseEvent(event);
      if (release.position) {
        feature.sendTerminalMouseSequence(
          socket,
          feature.terminalMouseEventCode(release.buttonCode, event),
          release.position,
          "m",
        );
      }
      if (container.hasPointerCapture?.(release.pointerID)) {
        container.releasePointerCapture(release.pointerID);
      }
      return true;
    };

    // A program in mode 1003 hears about motion without a button too. Shift,
    // Ctrl and Cmd keep the pointer for the terminal, as they do for clicks.
    const reportHover = (event) => {
      if (phoneSelecting()) { hover.reset(); return; }
      if (event.buttons !== 0 || !feature.terminalShouldReportMouse(term, event) || !feature.terminalReportsMotion(term)) {
        hover.reset();
        return;
      }
      const position = feature.terminalMousePosition(term, container, event);
      if (!position || !hover.move(position)) {
        return;
      }
      feature.sendTerminalMouseSequence(socket, feature.terminalMouseEventCode(terminalHoverButtonCode, event), position, "M");
    };

    const onPointerLeave = () => {
      hover.reset();
    };

    const onPointerMove = (event) => {
      if (cancelledTouches.has(event.pointerId)) {
        feature.stopTerminalMouseEvent(event);
        return;
      }
      const moved = touchScroll.move(event);
      if (moved !== null) {
        feature.stopTerminalMouseEvent(event);
        if (moved) scrollByTouch(-moved, event);
        return;
      }
      if (localSelectionID === event.pointerId) {
        feature.stopTerminalMouseEvent(event);
        term.selectionIntegration?.movePointerSelection?.(event);
        return;
      }
      if (!activePress.matches(event.pointerId)) {
        if (phoneScrollMode()) return;
        reportHover(event);
        return;
      }
      hover.reset();
      if (event.buttons === 0) {
        finishTerminalPointer(event);
        return;
      }
      const position = feature.terminalMousePosition(term, container, event);
      if (!position) {
        return;
      }
      feature.stopTerminalMouseEvent(event);
      if (!activePress.update(event.pointerId, position)) {
        return;
      }
      feature.sendTerminalMouseSequence(
        socket,
        feature.terminalMouseEventCode(activePress.buttonCode + 32, event),
        position,
        "M",
      );
    };

    const onPointerUp = (event) => {
      if (localSelectionID === event.pointerId) {
        term.selectionIntegration?.endPointerSelection?.(event);
        localSelectionID = null;
        touchScroll.up(event);
        releaseCapture(event.pointerId);
        feature.stopTerminalMouseEvent(event);
        return;
      }
      releaseCapture(event.pointerId);
      if (cancelledTouches.delete(event.pointerId)) {
        feature.stopTerminalMouseEvent(event);
        return;
      }
      if (touchScroll.up(event)) {
        feature.stopTerminalMouseEvent(event);
        return;
      }
      finishTerminalPointer(event);
    };

    const onPointerCancel = (event) => {
      if (localSelectionID === event.pointerId) {
        term.selectionIntegration?.endPointerSelection?.(event);
        localSelectionID = null;
      }
      releaseCapture(event.pointerId);
      if (cancelledTouches.delete(event.pointerId)) {
        feature.stopTerminalMouseEvent(event);
        return;
      }
      if (touchScroll.up(event)) {
        feature.stopTerminalMouseEvent(event);
        return;
      }
      finishTerminalPointer(event);
    };

    const onLostPointerCapture = (event) => {
      if (localSelectionID === event.pointerId) {
        onPointerCancel(event);
        return;
      }
      if (touchScroll.touches.has(event.pointerId)) {
        touchScroll.up(event);
        cancelledTouches.add(event.pointerId);
        captures.delete(event.pointerId);
      }
      finishTerminalPointer(event);
    };

    const onContextMenu = (event) => {
      if (phoneSelecting()) { feature.stopTerminalMouseEvent(event); return; }
      if (phoneScrollMode()) {
        feature.stopTerminalMouseEvent(event);
        return;
      }
      const controlClick = controlPress || (dependencies.interactions().appleKeyboardLayout && event.button === 0 && event.ctrlKey);
      controlPress = false;
      if (reportsMacControl(event) || feature.terminalShouldReportMouse(term, event)) {
        // macOS may show contextmenu before delivering pointerup for a
        // secondary click. Finish the already-forwarded press here so the TUI
        // cannot remain latched if that pointerup is suppressed.
        finishTerminalPointer(event, null);
        if ((event.button === 2 || controlClick) && contextMenuFallback.needsFallback(2, event.timeStamp)) {
          // Safari on macOS may emit only contextmenu for a trackpad secondary
          // click. In that case report one complete right-click to the TUI. A
          // recent pointerdown suppresses this fallback in browsers that deliver
          // the normal pointer sequence.
          const position = feature.terminalMousePosition(term, container, event);
          if (position) {
            const buttonCode = feature.terminalMouseEventCode(2, event);
            feature.sendTerminalMouseSequence(socket, buttonCode, position, "M");
            feature.sendTerminalMouseSequence(socket, buttonCode, position, "m");
          }
        }
        // ghostty-web can misinterpret a macOS secondary-click compatibility
        // event as a local left-button drag. Remove only a selection created
        // during this TUI-owned gesture, preserving any selection that predated
        // the click and preserving the normal right-click report to the TUI.
        clearTerminalSelectionStartedDuringGesture(term, selectionAtReportedPress);
        selectionAtReportedPress = null;
        feature.stopTerminalMouseEvent(event);
        return;
      }
      if (controlClick) {
        // Only a real right-click opens the terminal menu.
        feature.stopTerminalMouseEvent(event);
        return;
      }
      dependencies.menus().openTerminalMenu(event, rect);
    };

    const onClick = (event) => {
      if (phoneSelecting()) { feature.stopTerminalMouseEvent(event); return; }
      if (phoneScrollMode() || scrollModeGesture) {
        feature.stopTerminalMouseEvent(event);
        return;
      }
      // Control-click is a macOS context-menu gesture. Command-click remains
      // the link accelerator for both detected URLs and OSC 8 hyperlinks.
      if (dependencies.interactions().appleKeyboardLayout && event.ctrlKey) feature.stopTerminalMouseEvent(event);
    };

    const onWheel = (event) => {
      if (event.deltaY === 0) {
        return false;
      }

      const direction = event.deltaY < 0 ? -1 : 1;
      if (feature.terminalShouldReportMouse(term, event)) {
        const position = feature.terminalMousePosition(term, container, event);
        if (!position) {
          return false;
        }
        const buttonCode = direction < 0 ? 64 : 65;
        const baseSteps = Math.min(5, Math.abs(wheelDeltaUnits(event.deltaY, event.deltaMode, 40, term.rows)));
        const steps = scaledDiscreteWheelSteps(baseSteps, direction);
        for (let index = 0; index < steps; index += 1) {
          feature.sendTerminalMouseSequence(socket, feature.terminalMouseEventCode(buttonCode, event), position, "M");
        }
        return true;
      }

      if (term.wasmTerm?.isAlternateScreen?.()) {
        if (phoneSelecting()) return true;
        const baseSteps = Math.min(5, Math.abs(wheelDeltaUnits(event.deltaY, event.deltaMode, 33, term.rows)));
        const steps = scaledDiscreteWheelSteps(baseSteps, direction);
        const sequence = direction < 0 ? "\x1B[A" : "\x1B[B";
        for (let index = 0; index < steps; index += 1) {
          term.input(sequence, true);
        }
        return true;
      }

      const lineHeight = term.renderer?.getMetrics?.().height || 20;
      wheelRemainder = 0;
      wheelDirection = 0;
      const lines = wheelDeltaUnits(event.deltaY, event.deltaMode, lineHeight, term.rows);
      term.scrollWheelLines(lines * dependencies.preferences().terminalWheelSensitivity);
      return true;
    };

    container.addEventListener("pointerdown", onPointerDown, { capture: true });
    container.addEventListener("mousedown", onMouseDown, { capture: true });
    for (const type of ["mousemove", "mouseleave", "dblclick"]) container.addEventListener(type, onSelectionMouseEvent, { capture: true });
    container.addEventListener("pointermove", onPointerMove, { capture: true });
    container.addEventListener("pointerleave", onPointerLeave);
    container.addEventListener("pointerup", onPointerUp, { capture: true });
    container.addEventListener("pointercancel", onPointerCancel, { capture: true });
    container.addEventListener("lostpointercapture", onLostPointerCapture, { capture: true });
    container.addEventListener("contextmenu", onContextMenu, { capture: true });
    container.addEventListener("click", onClick, { capture: true });
    container.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });
    container.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
    container.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: false });
    term.attachCustomWheelEventHandler?.(onWheel);

    // Text reading is an overlay rather than the canvas. Give it the same
    // one/two-finger routing in Scroll mode, while leaving its native text
    // selection and scrolling alone in Interaction mode. Other panes' bridges
    // ignore this shared surface.
    const readingListeners = [
      ["pointerdown", onPointerDown], ["pointermove", onPointerMove],
      ["pointerup", onPointerUp], ["pointercancel", onPointerCancel],
      ["mousedown", onMouseDown], ["click", onClick], ["contextmenu", onContextMenu],
      ["touchstart", onTouchStart], ["touchend", onTouchEnd], ["touchcancel", onTouchEnd],
    ].map(([type, handler]) => {
      const listener = event => {
        if (phoneView?.active && phoneView.openPaneID === rect.id
            && (phoneScrollMode() || cancelledTouches.has(event.pointerId))) handler(event);
      };
      readingSurface?.addEventListener(type, listener, { capture: true, passive: false });
      return [type, listener];
    });

    const cancelTouchGesture = () => {
      term.selectionIntegration?.endPointerSelection?.();
      localSelectionID = null;
      term.selectionIntegration?.cancelDrag?.();
      for (const id of touchScroll.touches.keys()) cancelledTouches.add(id);
      touchScroll.reset();
      touchRemainder = 0;
      const release = activePress.finish(null);
      if (release?.position) {
        feature.sendTerminalMouseSequence(socket, release.buttonCode, release.position, "m");
        if (container.hasPointerCapture?.(release.pointerID)) captures.set(release.pointerID, container);
      }
      selectionAtTouch = null;
      hover.reset();
      for (const id of captures.keys()) releaseCapture(id);
    };

    // Mode changes release capture, so the finger can lift outside the canvas.
    // Observe those releases without intercepting unrelated page gestures.
    const onOutsidePointerEnd = event => {
      if (event.pointerType !== "touch" || container.contains?.(event.target) || readingSurface?.contains?.(event.target)) return;
      if (!touchScroll.touches.has(event.pointerId) && !cancelledTouches.has(event.pointerId)) return;
      if (event.type === "pointerup") onPointerUp(event);
      else onPointerCancel(event);
    };
    const onAllTouchesEnded = event => {
      if (event.touches?.length !== 0 || (!touchScroll.touches.size && !cancelledTouches.size)) return;
      cancelTouchGesture();
      cancelledTouches.clear();
      // Keep multiTouch until the target's touchend handler suppresses focus.
    };
    const onVisibilityChange = () => { if (platform.document.hidden) cancelTouchGesture(); };
    for (const type of ["pointerup", "pointercancel"]) platform.document?.addEventListener?.(type, onOutsidePointerEnd, { capture: true });
    for (const type of ["touchend", "touchcancel"]) platform.document?.addEventListener?.(type, onAllTouchesEnded, { capture: true, passive: true });
    platform.document?.addEventListener?.("visibilitychange", onVisibilityChange);
    platform.window?.addEventListener?.("blur", cancelTouchGesture);
    // A terminal can finish loading after its phone view has already opened.
    if (phoneView?.active && phoneView.openPaneID === rect.id) {
      term.selectionIntegration?.setInputSuppressed?.(!feature.phoneTypingInto(rect));
    }

    return {
      cancelTouchGesture,
      dispose() {
        cancelTouchGesture();
        for (const type of ["pointerup", "pointercancel"]) platform.document?.removeEventListener?.(type, onOutsidePointerEnd, { capture: true });
        for (const type of ["touchend", "touchcancel"]) platform.document?.removeEventListener?.(type, onAllTouchesEnded, { capture: true });
        platform.document?.removeEventListener?.("visibilitychange", onVisibilityChange);
        platform.window?.removeEventListener?.("blur", cancelTouchGesture);
        for (const id of captures.keys()) releaseCapture(id);
        container.removeEventListener("pointerdown", onPointerDown, { capture: true });
        container.removeEventListener("mousedown", onMouseDown, { capture: true });
        for (const type of ["mousemove", "mouseleave", "dblclick"]) container.removeEventListener(type, onSelectionMouseEvent, { capture: true });
        container.removeEventListener("pointermove", onPointerMove, { capture: true });
        container.removeEventListener("pointerleave", onPointerLeave);
        container.removeEventListener("pointerup", onPointerUp, { capture: true });
        container.removeEventListener("pointercancel", onPointerCancel, { capture: true });
        container.removeEventListener("lostpointercapture", onLostPointerCapture, { capture: true });
        container.removeEventListener("contextmenu", onContextMenu, { capture: true });
        container.removeEventListener("click", onClick, { capture: true });
        container.removeEventListener("touchstart", onTouchStart, { capture: true });
        container.removeEventListener("touchend", onTouchEnd, { capture: true });
        container.removeEventListener("touchcancel", onTouchEnd, { capture: true });
        term.attachCustomWheelEventHandler?.(null);
        for (const [type, listener] of readingListeners) readingSurface?.removeEventListener(type, listener, { capture: true });
      },
    };
  }

  function terminalShouldReportMouse(term, event, { allowControl = false } = {}) {
    if (event.shiftKey || (event.ctrlKey && !allowControl) || event.metaKey) {
      return false;
    }
    try {
      return Boolean(term?.hasMouseTracking?.());
    } catch {
      return false;
    }
  }

  // Any-event tracking: the program wants motion with no button held.
  function terminalReportsMotion(term) {
    try {
      return Boolean(term?.getMode?.(1003, false));
    } catch {
      return false;
    }
  }

  function terminalMouseButtonCode(button) {
    if (button === 0) {
      return 0;
    }
    if (button === 1) {
      return 1;
    }
    if (button === 2) {
      return 2;
    }
    return null;
  }

  function terminalMouseEventCode(buttonCode, event) {
    let code = buttonCode;
    if (event.shiftKey) {
      code += 4;
    }
    if (event.altKey || event.metaKey) {
      code += 8;
    }
    if (event.ctrlKey) {
      code += 16;
    }
    return code;
  }

  function terminalMousePosition(term, container, event) {
    const canvas = container.querySelector("canvas");
    const box = canvas?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) {
      return null;
    }
    const col = Math.min(term.cols, Math.max(1, Math.floor((event.clientX - box.left) / (box.width / term.cols)) + 1));
    const row = Math.min(term.rows, Math.max(1, Math.floor((event.clientY - box.top) / (box.height / term.rows)) + 1));
    return { col, row };
  }

  function sendTerminalMouseSequence(socket, code, position, finalByte) {
    if (!socket || socket.readyState !== platform.WebSocket.OPEN) {
      return;
    }
    socket.send(terminalMouseMessage(`\x1b[<${code};${position.col};${position.row}${finalByte}`));
  }

  function stopTerminalMouseEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  Object.assign(feature, {
    pasteImageIntoTerminal,
    attachTerminalPasteBridge,
    phoneTypingInto,
    attachTerminalMouseBridge,
    terminalShouldReportMouse,
    terminalReportsMotion,
    terminalMouseButtonCode,
    terminalMouseEventCode,
    terminalMousePosition,
    sendTerminalMouseSequence,
    stopTerminalMouseEvent,
  });
  return feature;
}
