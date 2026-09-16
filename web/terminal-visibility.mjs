// Require a higher pane to contain the terminal's entire window footprint.
// Terminal canvas padding keeps its painted area inside the covering pane's
// borders. Title bars alone do not count as coverage.
export function terminalIsCovered(target, panes) {
  return panes.some((pane) => pane !== target && !pane.minimized
    && pane.kind !== "pending" && pane.zIndex > target.zIndex
    && pane.x <= target.x && pane.y <= target.y
    && pane.x + pane.width >= target.x + target.width
    && pane.y + pane.height >= target.y + target.height);
}
