const patch = Symbol.for("tessera.terminalViewportPaint");

export function installTerminalViewportReader(Renderer) {
  const prototype = Renderer?.prototype;
  if (!prototype || prototype[patch] || typeof prototype.render !== "function") return;
  const render = prototype.render;
  prototype.render = function(buffer, ...args) {
    const getViewport = buffer?.getViewport;
    if (typeof getViewport !== "function") return render.call(this, buffer, ...args);
    const ownViewport = Object.hasOwn(buffer, "getViewport");
    const getLine = buffer.getLine, ownLine = Object.hasOwn(buffer, "getLine");
    let viewport, loaded = false;
    // Ghostty getLine() decodes the whole viewport, then copies the requested
    // row. Share that decoded pool for this paint, preserving its row copies.
    // Cache JS cells rather than WASM views: history/image reads reuse the native
    // scratch buffer and can grow memory during the same frame.
    buffer.getViewport = function(...readArgs) {
      if (!loaded) {
        viewport = getViewport.apply(this, readArgs);
        loaded = true;
      }
      return viewport;
    };
    const rows = new Map();
    // Full paints keep the bulk reader. Sparse paints use the same pinned
    // GhosttyCell decoder and scratch allocation for just the requested row.
    // A few copied rows survive subsequent history reads and memory growth.
    const sparse = typeof buffer.exports?.tessera_sixel_viewport_row === "function"
      && typeof buffer.parseCellsIntoPool === "function" && typeof getLine === "function";
    let full = Boolean(args[0] || args[1] > 0 || args[3] > 0);
    let checked = false;
    if (sparse) buffer.getLine = function(row) {
      if (!Number.isInteger(row) || row < 0 || row >= this.rows) return null;
      if (!checked) {
        full ||= Boolean(this.needsFullRedraw?.());
        // Many dirty rows favor one bulk read over repeated native calls.
        if (!full && typeof this.isRowDirty === "function") {
          let dirty = 0;
          for (let y = 0; y < this.rows && dirty < 8; y++) if (this.isRowDirty(y)) dirty++;
          full = dirty >= Math.min(8, this.rows);
        }
        checked = true;
      }
      if (rows.size >= 8) full = true;
      if (full || loaded) return getLine.call(this, row);
      let cells = rows.get(row);
      if (!cells) {
        this.update();
        const count = this.cols, size = count * 16;
        if (!this.viewportBufferPtr || this.viewportBufferSize < size) {
          if (this.viewportBufferPtr) this.exports.ghostty_wasm_free_u8_array(this.viewportBufferPtr, this.viewportBufferSize);
          this.viewportBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(size);
          this.viewportBufferSize = size;
        }
        if (!this.viewportBufferPtr || this.exports.tessera_sixel_viewport_row(this.handle, row, this.viewportBufferPtr, count) !== count) {
          throw new Error("Terminal row read failed");
        }
        this.parseCellsIntoPool(this.viewportBufferPtr, count);
        cells = this.cellPool.slice(0, count).map(cell => ({ ...cell }));
        rows.set(row, cells);
      }
      return cells.map(cell => ({ ...cell }));
    };
    try {
      return render.call(this, buffer, ...args);
    } finally {
      // Never reuse cells across frames or leave selection/link readers cached.
      if (ownViewport) buffer.getViewport = getViewport;
      else delete buffer.getViewport;
      if (sparse) {
        if (ownLine) buffer.getLine = getLine;
        else delete buffer.getLine;
      }
    }
  };
  prototype[patch] = true;
}
