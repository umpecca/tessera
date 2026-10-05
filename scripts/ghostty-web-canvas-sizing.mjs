// Keep the canvas allocation and render-size comparison on the same pixel grid.
// Fail closed when the pinned upstream renderer changes these boundaries.
export function alignGhosttyWebCanvasSizing(source) {
  const replacements = [
    ["this.canvas.width = g * this.devicePixelRatio", "this.canvas.width = Math.round(g * this.devicePixelRatio)"],
    ["this.canvas.height = E * this.devicePixelRatio", "this.canvas.height = Math.round(E * this.devicePixelRatio)"],
    ["this.canvas.width !== D.cols * this.metrics.width * this.devicePixelRatio", "this.canvas.width !== Math.round(D.cols * this.metrics.width * this.devicePixelRatio)"],
    ["this.canvas.height !== D.rows * this.metrics.height * this.devicePixelRatio", "this.canvas.height !== Math.round(D.rows * this.metrics.height * this.devicePixelRatio)"],
    ["this.ctx.fillRect(0, 0, g, E);", "this.ctx.fillRect(0, 0, this.canvas.width / this.devicePixelRatio, this.canvas.height / this.devicePixelRatio);"],
  ];
  for (const [before, after] of replacements) {
    const count = source.split(before).length - 1, patched = source.split(after).length - 1;
    if (count === 0 && patched === 1) continue;
    if (count !== 1 || patched !== 0) throw new Error("Pinned ghostty-web canvas sizing changed");
    source = source.replace(before, after);
  }
  return source;
}
