import { focusPane, paneNeedsRaise } from "./pane-activation.mjs";

// DOM focus only: never selects/raises a pane, sends input or claims PTY size.
// Browser focus restoration is limited to installed web apps. Native callers
// explicitly request it after checking scene/privacy/presentation state.
export function createForegroundFocus(dependencies, platform = globalThis) {
  let generation = 0, timer = null;
  let win, doc;
  const visible = node => node?.isConnected && !node.closest?.("[hidden], [inert]")
    && node.getClientRects().length > 0;
  const installed = () => win.navigator?.standalone === true
    || win.matchMedia?.("(display-mode: standalone)").matches === true;

  function cancel() {
    generation++;
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
  }

  function request({ native = false } = {}) {
    win = platform.window; doc = platform.document;
    if (win.top && win.top !== win) return false;
    if (win.tesseraNativeDevice === "ipad" ? !native : !installed()) return false;
    cancel();
    const pane = dependencies.desktop().getActivePane();
    if (!pane) return false;
    const workspace = dependencies.navigation().workspaceID;
    const requestID = generation;

    function attempt(count) {
      timer = null;
      if (requestID !== generation || doc.hidden || win.tesseraNativeSuspended
          || dependencies.desktop().getActivePane() !== pane
          || dependencies.navigation().workspaceID !== workspace
          || pane.minimized || !pane.element?.isConnected) return false;
      // Closing an overlay must not unexpectedly revive an earlier request.
      if ([...doc.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], .command-palette, .window-switcher, .dock-menu, .screensaver')].some(visible)) return false;
      if (pane.findBar?.isOpen) return false;
      const phone = dependencies.phone().phoneView;
      if (phone?.active && (phone.openPaneID !== pane.id || phone.selecting
          || phone.mode === "scroll" || !phone.input?.direct)) return false;
      const focused = doc.activeElement;
      const selection = doc.getSelection?.();
      if (selection && !selection.isCollapsed) return false;
      // Keep form fields, search, selection/compose controls, frames and other
      // deliberate targets. A pane's outer frame itself can yield to its input.
      if (focused && focused !== doc.body && focused !== doc.documentElement && focused !== pane.element) return false;
      const panes = dependencies.desktop().rectangles.filter(rect => !rect.minimized && visible(rect.element));
      if (paneNeedsRaise(panes, pane)) return false;
      const retry = () => {
        if (count < 10) timer = win.setTimeout(() => attempt(count + 1), 100);
        return false;
      };
      if (!doc.hasFocus() || dependencies.workspace().isLoadingWorkspace || !visible(pane.element)) return retry();
      // A reconnect can leave a pane present while its local input is not ready.
      if (pane.kind === "terminal" && (!pane.terminal?.term?.isOpen || pane.terminal.term.isDisposed)) return retry();
      focusPane(pane);
      const target = doc.activeElement;
      if (target && target !== doc.body && target !== doc.documentElement && pane.element.contains(target)) return true;
      // WebKit may briefly refuse programmatic focus while foregrounding. Keep
      // retries bounded and cancellable; never synthesize a click or keystroke.
      return retry();
    }
    return attempt(0);
  }

  return { request, cancel };
}
