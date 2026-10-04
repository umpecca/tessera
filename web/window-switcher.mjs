export function windowSwitcherEntries(panes, activePaneID, options = {}) {
  const visible = panes
    .map((pane, sourceIndex) => ({ pane, sourceIndex }))
    .filter(({ pane }) => pane.kind !== "pending" && (options.includeMinimized || !pane.minimized));
  const total = visible.length;
  return visible.map(({ pane, sourceIndex }, index) => ({
    pane,
    id: pane.id,
    name: typeof pane.title === "string" && pane.title.trim()
      ? pane.title.trim()
      : `Window ${sourceIndex + 1}`,
    position: index + 1,
    total,
    active: pane.id === activePaneID,
  }));
}

// The array already supplies the saved pane positions. Swap neighboring real
// windows while leaving any unfinished drawing's slot and object intact.
export function moveWindowPane(panes, pane, direction) {
  const current = panes.indexOf(pane);
  if (current < 0 || pane.kind === "pending" || (direction !== -1 && direction !== 1)) return false;
  let target = current + direction;
  while (target >= 0 && target < panes.length && panes[target].kind === "pending") target += direction;
  if (target < 0 || target >= panes.length) return false;
  [panes[current], panes[target]] = [panes[target], panes[current]];
  return true;
}

// Insert among real windows without shifting pending drawing slots or changing
// any pane's geometry, stacking, or contents. A null anchor means the end.
export function placeWindowPaneBefore(panes, pane, beforePane) {
  const windows = panes.filter(item => item.kind !== "pending");
  const current = windows.indexOf(pane);
  if (current < 0 || pane === beforePane || (beforePane !== null && !windows.includes(beforePane))) return false;
  windows.splice(current, 1);
  const target = beforePane === null ? windows.length : windows.indexOf(beforePane);
  if (target === current) return false;
  windows.splice(target, 0, pane);
  let index = 0;
  for (let slot = 0; slot < panes.length; slot++) {
    if (panes[slot].kind !== "pending") panes[slot] = windows[index++];
  }
  return true;
}

export function adjacentWindowPane(panes, currentPane, direction) {
  const entries = windowSwitcherEntries(panes, currentPane?.id || "");
  if (entries.length === 0) {
    return null;
  }
  const currentIndex = entries.findIndex((entry) => entry.pane === currentPane);
  const nextIndex = (currentIndex + direction + entries.length) % entries.length;
  return entries[nextIndex].pane;
}
