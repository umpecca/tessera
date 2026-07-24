export function paneNeedsRaise(panes, pane) {
  return panes.some((other) => other !== pane && other.zIndex >= pane.zIndex);
}
